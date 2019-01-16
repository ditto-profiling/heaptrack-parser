import {readFileSync} from 'fs';
import {gunzipSync} from 'zlib';

import {Config, defaultConfig, Parser} from '../src/heaptrack-parser'

/**
 * Real data test.
 */
describe('Test', () => {
  it('Real data test', async (done) => {
    const compressedData: Buffer = readFileSync('./test/data/data_1.gz');
    const fileText: Buffer = gunzipSync(compressedData);
    const fileLines: string[] = fileText.toString().split(/\r?\n/);
    const config: Config = defaultConfig;
    config.chunkCallback = (callback: () => void) => setTimeout(callback, 0);
    const parser = new Parser(config);
    parser.parse(fileLines);

    parser.consumedChart$.subscribe(chart => {
      if (!chart) return;
      console.log(chart.rows.length);
      done();
    });
  });
})