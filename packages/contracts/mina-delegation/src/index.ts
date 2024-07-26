import {
  Bool,
  Bytes,
  Crypto,
  DynamicProof,
  ForeignCurve,
  Proof,
  PublicKey,
  Struct,
  UInt8,
  Void,
  ZkProgram,
  createEcdsa,
  createForeignCurve,
} from 'o1js';

// ----------------------------------------------------------------------------
// Common data types

/** A Mina foreign curve for Secp256k1, like Ethereum uses. */
export class Secp256k1 extends createForeignCurve(Crypto.CurveParams.Secp256k1) {
  /** Convert a standard hex public key into this provable struct. */
  static fromHex(publicKey: string): Secp256k1 {
    if (publicKey.startsWith('0x04') && publicKey.length === 4 + 64 + 64) {
      return Secp256k1.from({
        x: BigInt('0x' + publicKey.substring(4, 4 + 64)),
        y: BigInt('0x' + publicKey.substring(4 + 64, 4 + 64 + 64)),
      });
    } else if (publicKey.startsWith('0x') && publicKey.length === 2 + 64 + 64) {
      return Secp256k1.from({
        x: BigInt('0x' + publicKey.substring(2, 2 + 64)),
        y: BigInt('0x' + publicKey.substring(2 + 64, 2 + 64 + 64)),
      });
    } else {
      throw new Error('Bad public key format');
    }
  }
}

/** A Mina-provable ECDSA signature on the Secp256k1 curve, like Ethereum uses. */
export class Ecdsa extends createEcdsa(Secp256k1) {
  // o1js-provided fromHex is good enough
}

/** Ethereum's fixed prefix for `personal_sign` messages. **/
const ethereumPrefix = Bytes.fromString('\x19Ethereum Signed Message:\n');

/** Pack 254 bits of key's X and 1 bit of isOdd into 32 bytes. */
function encodeKey(k: PublicKey): UInt8[] {
  const bytes = [];
  const bits = [...k.x.toBits(254), k.isOdd];
  for (let i = 0; i < bits.length; i += 8) {
    let value = new UInt8(0);
    for (let j = 0; j < 8; j++) {
      value = value.mul(2).add(boolToU8(bits[i + j] ?? Bool(false)));
    }
    bytes.push(value);
  }
  return bytes;
}

function boolToU8(bool: Bool): UInt8 {
  return UInt8.from(bool.toField());
}

export type DelegationCommandProof = Proof<
  {
    // real data
    target: PublicKey;
    signer: ForeignCurve;
    // sort of a type system marker that the interior is a DelegationCommand?
    assertSignatureMatches(signature: Ecdsa): void;
  },
  void
>;
type _DelegationCommandProof = DelegationCommandProof;

/**
 * Prepare a ZkProgram that verifies an EVM signature delegating to a Mina
 * address under a specific prefix. The prefix will be seen by the user when
 * signing the message and should clearly indicate the limited scope of the
 * validity of the signature.
 *
 * @param prefix A prefix to distinguish these delegation orders from those for other systems.
 * @returns An o1js Struct, ZkProgram, and Proof tied to that prefix.
 *
 * @example
 * const { DelegationCommand, DelegationCommandProgram, DelegationCommandProof } =
 *   delegateEvmToMina('Click & Moo login: ');
 */
export function delegateEvmToMina(prefix: string) {
  // ----------------------------------------------------------------------------
  // Per-prefix data types
  const delegationPrefix = Bytes.fromString(prefix);

  class DelegationCommand extends Struct({
    /** Mina public key that the delegation order is issued for. */
    target: PublicKey,
    /** Ethereum public key that signed the delegation order. */
    signer: Secp256k1.provable,
  }) {
    constructor(value: { target: PublicKey; signer: Secp256k1 }) {
      if (!(value.target instanceof PublicKey)) {
        // Compensate for the possibility of duplicate o1js libraries that aren't
        // `instanceof` each other, which messes up checks inside o1js. Can be
        // caused by `npm link`ing to this package, for example.
        value = { ...value, target: PublicKey.fromBase58((value.target as PublicKey).toBase58()) };
      }
      super(value);
    }

    static #_innerMessage(target: PublicKey): Bytes {
      return Bytes.from([
        ...delegationPrefix.bytes,
        // Base64-encode encodeKey()
        ...Bytes.from(encodeKey(target)).base64Encode().bytes,
      ]);
    }

    /**
     * Get the message for an Etherum wallet to sign, WITHOUT the Ethereum prefix.
     * This is printable and should be passed to something like `personal_sign`.
     */
    static bytesToSign({ target }: { target: PublicKey }): Uint8Array {
      // Accepts an object so you can pass just a PublicKey OR a DelegationCommand.
      return this.#_innerMessage(target).toBytes();
    }

    /** Validate that the given Ethereum signature matches this order, WITH the Ethereum prefix. */
    assertSignatureMatches(signature: Ecdsa) {
      const inner = DelegationCommand.#_innerMessage(this.target);
      const fullMessage = Bytes.from([
        ...ethereumPrefix.bytes,
        // NOTE: `inner.length` is effectively a constant so it's okay to bake it in.
        ...Bytes.fromString(String(inner.length)).bytes,
        ...inner.bytes,
      ]);
      signature.verifyV2(fullMessage, this.signer).assertTrue();
    }
  }

  // ----------------------------------------------------------------------------
  // The provable program itself

  const DelegationCommandProgram = ZkProgram({
    name: `${prefix}DelegationCommandProgram`,

    publicInput: DelegationCommand,

    methods: {
      sign: {
        privateInputs: [Ecdsa.provable],

        async method(order: DelegationCommand, signature: Ecdsa) {
          order.assertSignatureMatches(signature);
        },
      },
    },
  });

  class DelegationCommandProof
    extends ZkProgram.Proof(DelegationCommandProgram)
    implements _DelegationCommandProof {}

  class DynamicDelegationCommandProof extends DynamicProof<typeof DelegationCommand, void> {
    static override publicInputType = DelegationCommand;
    static override publicOutputType = Void;
    static override maxProofsVerified = 0 as const;
  }

  return {
    /**
     * An order that a particular EVM address has signed to authorize (delegate)
     * a Mina address to act on its behalf.
     */
    DelegationCommand,
    /**
     * A simple {@link ZkProgram} that proves that a valid signature exists for an
     * input {@link DelegationCommand}.
     */
    DelegationCommandProgram,
    /** A verifiable proof of {@link DelegationCommandProgram}'s success. */
    DelegationCommandProof,
    // /** A dynamic version of {@link DelegationCommandProof}. */
    // DynamicDelegationCommandProof, <- causes ts4904 until we explicitly declare the return type
  };
}
