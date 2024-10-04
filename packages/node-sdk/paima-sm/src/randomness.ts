import Prando from '@paima/prando';
import type { ChainData } from './types.js';
import type { SubmittedData } from '@paima/chain-types';
import type pg from 'pg';
import { getBlockSeeds } from '@paima/db';
import { hashTogether } from '@paima/utils-backend';

export function randomnessRouter(n: number): typeof getSeed1 {
  if (n) return getSeed1;
  else throw Error('wrong randomness protocol set');
}

function parseInput(encodedInput: string): string[] {
  return (JSON.parse(encodedInput) as any[]).map(value => value.toString());
}

function chooseData(submittedData: SubmittedData[], seed: string): string[] {
  const prando = new Prando(seed);
  const randomSelection = (): boolean => {
    const randomValue = Math.round(prando.next());
    return randomValue === 1;
  };

  const chosenData: string[] = [];
  for (const dataChunk of submittedData) {
    if (randomSelection()) chosenData.push(dataChunk.inputNonce);
    if (randomSelection()) chosenData.push(dataChunk.realAddress);
    for (const data of parseInput(dataChunk.inputData)) {
      if (randomSelection()) chosenData.push(data);
    }
  }

  // Add random attribute of one of the submittedData in case nothing was picked
  if (submittedData.length > 0 && chosenData.length === 0) {
    const randomIndex = Math.floor(prando.next() * submittedData.length);
    const dataChunk = submittedData[randomIndex];
    const forcedOptions = [dataChunk.inputNonce, dataChunk.realAddress, dataChunk.inputData];
    const forcedValue = forcedOptions[Math.floor(prando.next() * forcedOptions.length)];
    chosenData.push(forcedValue);
  }

  return chosenData;
}

/*
 * Basic randomness generation protocol which hashes together previous seeds and randomly selected chain data
 */
async function getSeed1(latestChainData: ChainData, DBConn: pg.PoolClient): Promise<string> {
  const blockSeeds = (await getBlockSeeds.run(undefined, DBConn)).map(result => result.seed);
  const interimSeed = hashTogether([latestChainData.blockHash, ...blockSeeds]);
  const selectedChainData = chooseData(latestChainData.submittedData, interimSeed);
  const seed = hashTogether([...selectedChainData, latestChainData.blockHash, ...blockSeeds]);
  return seed;
}
