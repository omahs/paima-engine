import type { AvailConfig } from '@paima/utils';
import {
  doLog,
  logError,
  delay,
  ChainDataExtensionDatumType,
  ConfigNetworkType,
} from '@paima/utils';
import type { ChainFunnel, ReadPresyncDataFrom } from '@paima/runtime';
import type { CdeGenericDatum } from '@paima/sm';
import { type ChainData, type PresyncChainData } from '@paima/sm';
import { BaseFunnel } from '../BaseFunnel.js';
import type { FunnelSharedData } from '../BaseFunnel.js';
import type { AvailFunnelCacheEntryState } from '../FunnelCache.js';
import { AvailFunnelCacheEntry } from '../FunnelCache.js';
import type { PoolClient } from 'pg';
import { FUNNEL_PRESYNC_FINISHED } from '@paima/utils';
import type { ApiPromise } from 'avail-js-sdk';
import { createApi } from './createApi.js';
import { Header } from '@polkadot/types/interfaces/types.js';
import { getLatestProcessedCdeBlockheight } from '@paima/db';

function applyDelay(config: AvailConfig, baseTimestamp: number): number {
  return Math.max(baseTimestamp - (config.delay ?? 0), 0);
}

export class AvailFunnel extends BaseFunnel implements ChainFunnel {
  config: AvailConfig;
  chainName: string;

  protected constructor(
    sharedData: FunnelSharedData,
    dbTx: PoolClient,
    config: AvailConfig,
    chainName: string,
    private readonly baseFunnel: ChainFunnel
  ) {
    super(sharedData, dbTx);
    this.readData.bind(this);
    this.readPresyncData.bind(this);
    this.getDbTx.bind(this);
    this.config = config;
    this.chainName = chainName;
  }

  public override async readData(blockHeight: number): Promise<ChainData[]> {
    const cachedState = this.getState();

    // if in the previous round we couldn't return some blocks because the
    // parallel chain didn't get far enough, we first process those.
    if (cachedState.bufferedChainData.length === 0) {
      const baseData = await this.baseFunnel.readData(blockHeight);
      cachedState.bufferedChainData.push(...baseData);
    }

    await this.updateLatestBlock();
    const latestBlockQueryState = this.latestBlock();
    const latestHeaderTimestamp = latestBlockQueryState.slot * 20;

    const chainData: ChainData[] = [];

    // filter the data so that we are sure we can get all the blocks in the range
    for (const data of cachedState.bufferedChainData) {
      if (applyDelay(this.config, data.timestamp) <= latestHeaderTimestamp) {
        chainData.push(data);
      }
    }

    // the blocks that didn't pass the filter are kept in the cache, so that
    // the block funnel doesn't get them again.
    chainData.forEach(_ => cachedState.bufferedChainData.shift());

    if (chainData.length === 0) {
      return chainData;
    }

    if (!cachedState.lastBlock) {
      const queryResults = await getLatestProcessedCdeBlockheight.run(
        { network: this.chainName },
        this.dbTx
      );

      if (queryResults[0]) {
        // If we are in `readData`, we know that the presync stage finished.
        // This means `readPresyncData` was actually called with the entire
        // range up to startBlockHeight - 1 (inclusive), since that's the stop
        // condition for the presync. So there is no point in starting from
        // earlier than that, since we know there are no events there.
        cachedState.lastBlock = Math.max(
          queryResults[0].block_height,
          cachedState.startingBlockHeight - 1
        );
      } else {
        // The earliest parallel block we might have to sync
        // is one whose timestamp occurs after the timestamp of (current block - 1)
        const block = await this.sharedData.web3.eth.getBlock(chainData[0].blockNumber - 1);
        const ts = Number(block.timestamp);
        const earliestParallelChainBlock = await findBlockByTimestamp(
          cachedState.api,
          applyDelay(this.config, ts),
          this.chainName
        );
        // earliestParallelChainBlock is the earliest block that we might need to include
        // so earliestParallelChainBlock-1 is the first block we can ignore (the "lastBlock" we're done syncing)
        cachedState.lastBlock = earliestParallelChainBlock - 1;
      }
    }

    // fetch headers from avail
    const maxSlot = applyDelay(this.config, chainData[chainData.length - 1].timestamp) / 20;

    const headers = [];

    while (true) {
      const latestBlock = this.latestBlock();
      const to = Math.min(
        latestBlock.number,
        cachedState.lastBlock + this.config.funnelBlockGroupSize
      );

      doLog(`Avail funnel #${cachedState.lastBlock + 1}-${to}`);

      const availHeaders = await getMultipleHeaderData(
        cachedState.api,
        cachedState.lastBlock + 1,
        to
      );

      headers.push(...availHeaders);

      if (headers.length > 0) {
        const last = headers[headers.length - 1];

        cachedState.lastBlock = last.number;
      }

      if (headers.length > 0 && headers[headers.length - 1].slot >= maxSlot) {
        break;
      }

      if (to !== latestBlock.number) continue;
      while ((await this.updateLatestBlock()) === latestBlock?.number) {
        // wait for blocks to be produced
        await delay(500);
      }
    }

    for (const availHeader of headers) {
      cachedState.timestampToBlockNumber.push([availHeader.slot * 20, availHeader.number]);
      cachedState.latestBlock = availHeader;
    }

    while (true) {
      if (cachedState.timestampToBlockNumber.length === 0) {
        return chainData;
      }

      if (cachedState.timestampToBlockNumber[0][0] <= cachedState.lastMaxSlot * 20) {
        cachedState.timestampToBlockNumber.shift();
      } else {
        break;
      }
    }

    cachedState.lastMaxSlot = maxSlot;

    const availToMainchainBlockHeightMapping: { [blockNumber: number]: number } = {};

    let currIndex = 0;

    for (const availBlock of cachedState.timestampToBlockNumber) {
      while (currIndex < chainData.length) {
        if (applyDelay(this.config, chainData[currIndex].timestamp) >= availBlock[0]) {
          availToMainchainBlockHeightMapping[availBlock[1]] = chainData[currIndex].blockNumber;
          break;
        } else {
          currIndex++;
        }
      }
    }

    if (!cachedState.timestampToBlockNumber[0]) {
      return chainData;
    }

    if (cachedState.timestampToBlockNumber[0][0] > maxSlot * 20) {
      return chainData;
    }

    const fromBlock = cachedState.timestampToBlockNumber[0][1];

    let toBlock =
      getUpperBoundBlock(cachedState.timestampToBlockNumber, maxSlot * 20) ||
      // this works because we know that there is at least a block in the time
      // range, because of the previous if/early return.
      fromBlock;

    if (!toBlock || fromBlock < 0 || toBlock < fromBlock) {
      return chainData;
    }

    const availData = await getSubmittedData(
      this.config.lightClient,
      fromBlock,
      toBlock,
      this.chainName
    );

    for (const data of availData) {
      data.blockNumber = availToMainchainBlockHeightMapping[data.blockNumber];
    }

    composeChainData(chainData, availData);

    return chainData;
  }

  public override async readPresyncData(
    args: ReadPresyncDataFrom
  ): Promise<{ [network: string]: PresyncChainData[] | typeof FUNNEL_PRESYNC_FINISHED }> {
    const baseData = await this.baseFunnel.readPresyncData(args);

    let arg = args.find(arg => arg.network == this.chainName);

    if (!arg) {
      return baseData;
    }

    // TODO: a bit hacky, but there are no extensions for now, so the initial
    // point doesn't work
    let fromBlock = arg.from;
    let toBlock = arg.to;

    const startBlockHeight = this.getState().startingBlockHeight;

    if (fromBlock >= startBlockHeight) {
      return { ...baseData, [this.chainName]: FUNNEL_PRESYNC_FINISHED };
    }

    try {
      toBlock = Math.min(toBlock, startBlockHeight - 1);
      fromBlock = Math.max(fromBlock, 0);
      if (fromBlock > toBlock) {
        return baseData;
      }

      doLog(`Avail funnel presync ${this.chainName}: #${fromBlock}-${toBlock}`);

      const data = await getSubmittedData(
        this.config.lightClient,
        fromBlock,
        toBlock,
        this.chainName
      );

      return {
        ...baseData,
        [this.chainName]: data.map(d => ({
          extensionDatums: d.extensionDatums,
          networkType: ConfigNetworkType.AVAIL,
          network: this.chainName,
          blockNumber: d.blockNumber,
        })),
      };
    } catch (err) {
      doLog(`[paima-funnel::readPresyncData] Exception occurred while reading blocks: ${err}`);
      throw err;
    }
  }

  public static async recoverState(
    sharedData: FunnelSharedData,
    dbTx: PoolClient,
    baseFunnel: ChainFunnel,
    chainName: string,
    config: AvailConfig,
    startingBlockHeight: number
  ): Promise<AvailFunnel> {
    const availFunnelCacheEntry = ((): AvailFunnelCacheEntry => {
      const entry = sharedData.cacheManager.cacheEntries[AvailFunnelCacheEntry.SYMBOL];
      if (entry != null) return entry;

      const newEntry = new AvailFunnelCacheEntry();

      sharedData.cacheManager.cacheEntries[AvailFunnelCacheEntry.SYMBOL] = newEntry;
      return newEntry;
    })();

    if (!availFunnelCacheEntry.initialized()) {
      const startingBlock = await sharedData.web3.eth.getBlock(startingBlockHeight);

      const api = await createApi(config.rpc);

      const mappedStartingBlockHeight = await findBlockByTimestamp(
        api,
        applyDelay(config, Number(startingBlock.timestamp)),
        chainName
      );

      availFunnelCacheEntry.initialize(api, mappedStartingBlockHeight);
    }

    const funnel = new AvailFunnel(sharedData, dbTx, config, chainName, baseFunnel);

    await funnel.updateLatestBlock();

    return funnel;
  }

  private latestBlock(): { hash: string; number: number; slot: number } {
    const latestBlockQueryState =
      this.sharedData.cacheManager.cacheEntries[AvailFunnelCacheEntry.SYMBOL]?.getState();

    if (
      latestBlockQueryState?.latestBlock === undefined ||
      latestBlockQueryState.latestBlock === null
    ) {
      throw new Error('Latest block cache entry not initialized');
    }

    return latestBlockQueryState.latestBlock;
  }

  private async updateLatestBlock(): Promise<number> {
    const cachedState = this.getState();
    // TODO: timeout
    const latestHead = await cachedState.api.rpc.chain.getFinalizedHead();
    const latestHeader = await cachedState.api.rpc.chain.getHeader(latestHead);

    const delayedBlock = Math.max(
      latestHeader.number.toNumber() - (this.config.confirmationDepth ?? 0),
      1
    );

    const delayedBlockHash = await cachedState.api.rpc.chain.getBlockHash(delayedBlock);
    const delayedHeader = await cachedState.api.rpc.chain.getHeader(delayedBlockHash);

    const slot = getSlotFromHeader(delayedHeader, cachedState.api);

    this.sharedData.cacheManager.cacheEntries[AvailFunnelCacheEntry.SYMBOL]?.updateLatestBlock({
      number: delayedHeader.number.toNumber(),
      hash: delayedBlockHash.toString(),
      slot: slot,
    });

    return delayedBlock;
  }

  private getState(): AvailFunnelCacheEntryState {
    const bufferedState =
      this.sharedData.cacheManager.cacheEntries[AvailFunnelCacheEntry.SYMBOL]?.getState();

    if (bufferedState === null || bufferedState === undefined) {
      throw new Error(`[funnel] avail funnel state not initialized`);
    }

    return bufferedState;
  }
}

export async function wrapToAvailFunnel(
  chainFunnel: ChainFunnel,
  sharedData: FunnelSharedData,
  dbTx: PoolClient,
  startingBlockHeight: number,
  chainName: string,
  config: AvailConfig
): Promise<ChainFunnel> {
  try {
    const ebp = await AvailFunnel.recoverState(
      sharedData,
      dbTx,
      chainFunnel,
      chainName,
      config,
      startingBlockHeight
    );
    return ebp;
  } catch (err) {
    doLog('[paima-funnel] Unable to initialize avail events processor:');
    logError(err);
    throw new Error('[paima-funnel] Unable to initialize avail events processor');
  }
}

type HeaderData = { number: number; hash: string; slot: number };

async function getMultipleHeaderData(
  api: ApiPromise,
  from: number,
  to: number
): Promise<HeaderData[]> {
  const results = [] as HeaderData[];

  for (let bn = from; bn < to; bn++) {
    // NOTE: the light client allows getting header directly from block number,
    // but it doesn't provide the babe data for the slot

    // TODO: probably this can be batched?
    const hash = await api.rpc.chain.getBlockHash(bn);
    const header = await api.rpc.chain.getHeader(hash);

    const slot = getSlotFromHeader(header, api);

    results.push({
      number: header.number.toNumber(),
      hash: header.hash.toString(),
      slot: slot,
    });
  }

  return results;
}

function getSlotFromHeader(header: Header, api: ApiPromise): number {
  const preRuntime = header.digest.logs.find(log => log.isPreRuntime)!.asPreRuntime;

  // FIXME: duplicated code
  const rawBabeDigest = api.createType('RawBabePreDigest', preRuntime[1]);

  const babeDigest = rawBabeDigest.toPrimitive() as unknown as any;

  // the object is an enumeration, but all the variants have a slotNumber field
  const slot = babeDigest[Object.getOwnPropertyNames(babeDigest)[0]].slotNumber;
  return slot;
}

// finds the last block in the timestampToBlockNumber collection that is between
// the range: (-Infinity, maxTimestamp]
// PRE: timestampToBlockNumber should be sorted by timestamp (first element of the tuple)
function getUpperBoundBlock(
  timestampToBlockNumber: [number, number][],
  maxTimestamp: number
): number | undefined {
  let toBlock: number | undefined = undefined;

  for (let i = timestampToBlockNumber.length - 1; i >= 0; i--) {
    const [ts, toBlockInner] = timestampToBlockNumber[i];

    if (maxTimestamp >= ts) {
      toBlock = toBlockInner;
      // we are going backwards, so we can stop
      break;
    }
  }

  return toBlock;
}

async function getSubmittedData(
  lc: string,
  from: number,
  to: number,
  network: string
): Promise<{ blockNumber: number; extensionDatums: CdeGenericDatum[] }[]> {
  const data = [] as { blockNumber: number; extensionDatums: CdeGenericDatum[] }[];

  for (let curr = from; curr <= to; curr++) {
    const responseRaw = await fetch(`${lc}/v2/blocks/${curr}/data`);

    // TODO: handle better the status code ( not documented ).
    if (responseRaw.status !== 200) {
      continue;
    }

    const response = (await responseRaw.json()) as unknown as {
      block_number: number;
      data_transactions: { data: string }[];
    };

    if (response.data_transactions.length > 0) {
      // not sure how this would be controlled by extensions yet, so for now we
      // just generate a generic event, since the app_id is in the client, and the
      // data doesn't have a format.
      data.push({
        blockNumber: response.block_number,
        extensionDatums: response.data_transactions.map(d => ({
          cdeName: 'availDefaultExtension',
          blockNumber: response.block_number,
          transactionHash: 'hash',
          payload: { data: d.data },
          cdeDatumType: ChainDataExtensionDatumType.Generic,
          scheduledPrefix: 'avail',
          network: network,
        })),
      });
    }
  }

  return data;
}

export function composeChainData(
  baseChainData: ChainData[],
  cdeData: { blockNumber: number; extensionDatums: CdeGenericDatum[] }[]
): ChainData[] {
  return baseChainData.map(blockData => {
    const matchingData = cdeData.find(
      blockCdeData => blockCdeData.blockNumber === blockData.blockNumber
    );

    if (!matchingData) {
      return blockData;
    }

    if (blockData.extensionDatums) {
      if (matchingData.extensionDatums) {
        blockData.extensionDatums.push(...matchingData.extensionDatums);
      }
    } else if (matchingData.extensionDatums) {
      blockData.extensionDatums = matchingData.extensionDatums;
    }

    return blockData;
  });
}

// TODO: duplicated code
/*
 * performs binary search to find the block corresponding to a specific timestamp
 * Note: if there are multiple blocks with the same timestamp
 * @returns the index of the first block that occurs > targetTimestamp
 */
async function findBlockByTimestamp(
  api: ApiPromise,
  targetTimestamp: number,
  chainName: string
): Promise<number> {
  let low = 1;
  // TODO: check this
  // blocks are 0-indexed, so we add +1 to get the size
  let highHash = await api.rpc.chain.getFinalizedHead();

  let high = (await api.rpc.chain.getHeader(highHash)).number.toNumber() + 1;

  let requests = 0;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    const hash = await api.rpc.chain.getBlockHash(mid);
    const header = await api.rpc.chain.getHeader(hash);

    const slot = getSlotFromHeader(header, api);

    requests++;

    // recall: there may be many blocks with the same targetTimestamp
    // in this case, <= means we slowly increase `low` to return the most recent block with that timestamp
    if (Number(slot * 20) <= targetTimestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  doLog(
    `avail funnel: Found block #${low} on ${chainName} by binary search with ${requests} requests`
  );

  return low;
}
