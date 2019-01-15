import {readFileSync} from 'fs';
import {gunzipSync} from 'zlib';

import {Parser} from '../src/heaptrack-parser'

/**
 * Real data test.
 */
describe('Test', () => {
  it('Real data test', () => {
    const compressedData: Buffer = readFileSync('./test/data/data_1.gz');
    const fileText: Buffer = gunzipSync(compressedData);
    const fileLines: string[] = fileText.toString().split(/\r?\n/);
    new Parser(fileLines);
  });
})