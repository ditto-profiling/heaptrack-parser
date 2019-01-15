import {Parser} from "../src/heaptrack-parser"
import { createReadStream, fstat, readFileSync } from "fs";

/**
 * Test
 */
describe('Test', () => {
  it('Real data test', () => {
    const data: Buffer = readFileSync('./test//data/testdata.txt');
    const fileLines: string[] = data.toString().split(/\r?\n/);
    new Parser(fileLines);
  });
})