import type { PostExecutionBlockHeader } from './types.js';
import { keccak_256 } from 'js-sha3';

export function genV1BlockHeader(
  mainChainInfo: {
    blockHash: string;
    blockHeight: number;
    msTimestamp: number;
  },
  prevBlockHash: null | string,
  successfulTxs: string[],
  failedTxs: string[]
): PostExecutionBlockHeader<1> {
  return {
    version: 1 as const,
    prevBlockHash,
    mainChainBlochHash: mainChainInfo.blockHash,
    blockHeight: mainChainInfo.blockHeight,
    msTimestamp: mainChainInfo.msTimestamp,
    successTxsHash: hashTransactions.hash(successfulTxs),
    failedTxsHash: hashTransactions.hash(failedTxs),
  };
}

interface HashInfo<T> {
  preHash: (info: T) => string;
  hash: (info: T) => string;
}
export const hashTransactions: HashInfo<string[]> = {
  preHash: txs => txs.join('|'),
  hash: txs => keccak_256(hashTransactions.preHash(txs)),
};

export const hashBlock: HashInfo<PostExecutionBlockHeader<1>> = {
  preHash: header =>
    `${header.version}|${header.prevBlockHash}|${header.mainChainBlochHash}|${header.blockHeight}|${header.msTimestamp}|${header.successTxsHash}|${header.failedTxsHash}`,
  hash: header => keccak_256(hashBlock.preHash(header)),
};

export type ScheduledDataHashInfo = {
  caip2Prefix: string;
  txHash: string;
  indexInBlock: number;
};
export const hashScheduledData: HashInfo<ScheduledDataHashInfo> = {
  preHash: info => `${info.caip2Prefix}}|${info.txHash}|${info.indexInBlock}`,
  hash: info => keccak_256(hashScheduledData.preHash(info)),
};

type SubmittedDataHashInfo = ScheduledDataHashInfo;
export const hashSubmittedData: HashInfo<SubmittedDataHashInfo> = {
  preHash: info => `${info.caip2Prefix}}|${info.txHash}|${info.indexInBlock}`,
  hash: info => keccak_256(hashScheduledData.preHash(info)),
};

export type TimerHashInfo = {
  address: string;
  dataHash: string;
  blockHeight: number;
  indexInBlock: number;
};
export const hashTimerData: HashInfo<TimerHashInfo> = {
  preHash: info => `${info.address}|${info.dataHash}|${info.blockHeight}|${info.indexInBlock}`,
  hash: info => keccak_256(hashTimerData.preHash(info)),
};
