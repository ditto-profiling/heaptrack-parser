import {BehaviorSubject, Observable} from 'rxjs';

import {Config, defaultConfig} from './config';

/**
 * A node for navigating through traces.
 */
interface TraceNode {
  ipIndex: number|null;
  parentIndex: number|null;
}

/**
 * An instruction pointer with module, frame and inlined information.
 */
interface InstructionPointer {
  instructionPointer: string;
  moduleIndex: number;
  frame: Frame;
  inlined: Frame[];
}

/**
 * A stack frame.
 */
interface Frame {
  functionIndex: number|null;
  fileIndex: number|null;
  line: number|null;
}

/**
 *  Memory allocation size and index.
 */
interface AllocationInfo {
  size: number;
  allocationIndex: number|null;
}

/**
 * Memory allocation cost data.
 */
interface AllocationData {
  allocations: number;
  temporary: number;
  leaked: number;
  peak: number;
}

/**
 * Memory allocation cost data.
 */
interface Allocation extends AllocationData {
  traceIndex: number;
}

/**
 * Overall cost data.
 */
export interface TotalCost {
  allocations: number;
  allocated: number;
  leaked: number;
  peak: number;
  temporary: number;
}

/**
 * Summary data.
 */
export interface SummaryData extends TotalCost {
  debuggee: string|null;
  totalTime: number;
  fromAttached: boolean;
  peakTime: number;
  peakRss: number;
}

/**
 * Data rows and label map for creating a chart.
 */
export interface Chart {
  rows: ChartRow[];
  labels: Map<number, string>;
}

/**
 * Parser mode of operation.
 */
const ModeEnum = {
  FIRST: 0,
  SECOND: 1,
  THIRD: 2
}

/**
 * A parsed file line.
 */
interface FileLine {
  line: string;
  op: string;
  args: string[];
}

/**
 * Chart merge data.
 */
interface ChartMergeData {
  ip: number;
  consumed: number;
  allocations: number;
  temporary: number;
}

/**
 * Label IDs.
 */
interface LabelIds {
  consumed: number;
  allocations: number;
  temporary: number;
}

/**
 * A debugging symbol.
 */
interface Symbol {
  symbol: string;
  binary: string;
  path: string;
}

/**
 * Hierarchical chart row data.
 */
export interface RowData {
  cost: AllocationData;
  symbol: Symbol;
  parent: RowData|null;
  children: RowData[];
}

/**
 * Entry cost.
 */
interface EntryCost {
  inclusiveCost: AllocationData;
  selfCost: AllocationData;
}

/**
 * Caller-callee entry info.
 */
interface CallerCalleeEntry extends EntryCost {
  callers: Map<Symbol, AllocationData>;
  callees: Map<Symbol, AllocationData>;
  sourceMap: Map<number, EntryCost>;
}

/**
 * Caller-callee results.
 */
interface CallerCalleeResults {
  entries: Map<Symbol, CallerCalleeEntry>;
  totalCosts: AllocationData;
}

/**
 * Location info.
 */
interface Location {
  symbol: Symbol;
  fileLine: number|null;
}

/**
 * Time series data chart row.
 */
export interface ChartRow {
  timestamp: number;
  cost: number[];
}

/**
 * Counted allocation info.
 */
interface CountedAllocationInfo {
  info: AllocationInfo;
  allocations: number;
}

/**
 * The parser object.
 */
export class Parser {
  public summary$: Observable<SummaryData|null>;
  public consumedChart$: Observable<Chart|null>;
  public allocationsChart$: Observable<Chart|null>;
  public temporaryChart$: Observable<Chart|null>;
  public topDownData$: Observable<RowData[]|null>;
  public bottomDownData$: Observable<RowData[]|null>;

  private summarySubject = new BehaviorSubject<SummaryData|null>(null);
  private consumedChartSubject = new BehaviorSubject<Chart|null>(null);
  private allocationsChartSubject = new BehaviorSubject<Chart|null>(null);
  private temporaryChartSubject = new BehaviorSubject<Chart|null>(null);
  private topDownDataSubject = new BehaviorSubject<RowData[]|null>(null);
  private bottomDownDataSubject = new BehaviorSubject<RowData[]|null>(null);

  private consumedChartData:
      Chart = {rows: [], labels: new Map<number, string>()};
  private allocationsChartData:
      Chart = {rows: [], labels: new Map<number, string>()};
  private temporaryChartData:
      Chart = {rows: [], labels: new Map<number, string>()};

  private totalCost: TotalCost =
      {allocations: 0, allocated: 0, leaked: 0, peak: 0, temporary: 0};
  private peakTime: number = 0;
  private peakRss: number = 0;
  private debuggee: string|null = null;
  private totalTime: number = 0;
  private fromAttached: boolean = false;
  private maxAllocationIndex: number = 0;
  private traceIndexToAllocationIndex = new Map<number, number>();
  private allocations: Allocation[] = [];
  private strings: string[] = [];
  private newStrIndices: number[] = [];
  private stopIndices: number[] = [];
  private newIpIndices: number[] = [];
  private executableFound: boolean = false;
  private lastAllocationPtr: number = 0;
  private timestamp: number = 0;
  private newStrings: string[] = this.config.newStrings;
  private stopStrings: string[] = this.config.stopStrings;

  private lastPeakCost: number = 0;
  private lastPeakTime: number = 0;
  private maxConsumedSinceLastTimeStamp: number = 0;
  private labelIds = new Map<number, LabelIds>();
  private pathToBinaries = new Map<string, string>();
  private allocationInfoCounter: CountedAllocationInfo[] = [];
  private buildCharts: boolean = false;
  private lastTimestamp: number = 0;

  private traces: TraceNode[] = [];
  private instructionPointers: InstructionPointer[] = [];
  private allocationInfos: AllocationInfo[] = [];

  /**
   * Constructor.
   * @param fileText The text of the file to parse.
   * @param config The configuration object.
   */
  constructor(fileText: string[], private config: Config = defaultConfig) {
    // Prepare the observables.
    this.summary$ = this.summarySubject.asObservable();
    this.consumedChart$ = this.consumedChartSubject.asObservable();
    this.allocationsChart$ = this.allocationsChartSubject.asObservable();
    this.temporaryChart$ = this.temporaryChartSubject.asObservable();
    this.topDownData$ = this.topDownDataSubject.asObservable();
    this.bottomDownData$ = this.bottomDownDataSubject.asObservable();

    // Parse the file lines.
    const fileLines: FileLine[] = [];
    for (const line of fileText) {
      const [op, ...args]: string[] = line.split(' ');
      fileLines.push({line: line, op: op, args: args})
    }

    // Start with the first pass.
    this.config.chunkCallback(
        () => this.parseFile(
            fileLines, ModeEnum.FIRST, () => this.secondPass(fileLines)));
  }

  /**
   * Perform the second pass.
   * @param fileText The text of the file to parse.
   */
  private secondPass(fileLines: FileLine[]): void {
    this.parseFile(fileLines, ModeEnum.SECOND, () => this.thirdPass(fileLines));
  }

  /**
   * Perform the third pass.
   * @param fileText The text of the file to parse.
   */
  private thirdPass(fileLines: FileLine[]): void {
    // The summary data is ready.
    this.summarySubject.next({
      debuggee: this.debuggee,
      totalTime: this.totalTime,
      fromAttached: this.fromAttached,
      peakTime: this.peakTime,
      peakRss: this.peakRss,
      allocations: this.totalCost.allocations,
      allocated: this.totalCost.allocated,
      leaked: this.totalCost.leaked,
      peak: this.totalCost.peak,
      temporary: this.totalCost.temporary
    });

    const {topRows, callerCalleeResults} = this.mergeAllocations();
    const bottomDownData: RowData[] = topRows;

    this.bottomDownDataSubject.next(bottomDownData);  // emit bottom-down data
    this.buildSizeHistogram();
    this.topDownDataSubject.next(
        this.toTopDownData(topRows));  // emit top-down data
    this.writeCallerCalleeData(topRows, callerCalleeResults);
    this.prepareCharts();
    this.parseFile(fileLines, ModeEnum.THIRD);  // final parse (no callback)

    // The chart data is ready.
    this.consumedChartSubject.next(this.consumedChartData);
    this.allocationsChartSubject.next(this.allocationsChartData);
    this.temporaryChartSubject.next(this.temporaryChartData);
  }

  /**
   * Parse the file.
   * @param fileText The text of the file to parse.
   * @param mode The mode (first, second, third).
   * @param callback The post-parsing callback.
   */
  private parseFile(
      fileLines: FileLine[], mode: number,
      callback: () => void = () => undefined): void {
    this.lastPeakCost = (mode !== ModeEnum.FIRST) ? this.totalCost.peak : 0;
    this.lastPeakTime = (mode !== ModeEnum.FIRST) ? this.peakTime : 0;

    for (const allocation of this.allocations) {
      allocation.allocations = 0;
      allocation.leaked = 0;
      allocation.peak = 0;
      allocation.temporary = 0;
    }

    this.totalCost =
        {allocations: 0, allocated: 0, leaked: 0, peak: 0, temporary: 0};
    this.peakTime = 0;
    this.peakRss = 0;
    this.executableFound = false;

    const fileLinesSet: FileLine[][] = [];

    // Split the lines into chunks.
    const max = fileLines.length;
    for (let i = 0; i * this.config.chunkSize < max; ++i) {
      fileLinesSet.push(fileLines.slice(
          i * this.config.chunkSize, (i + 1) * this.config.chunkSize));
    }

    fileLinesSet.reverse();
    this.config.chunkCallback(
        () => this.parseFileRecursively(fileLinesSet, mode, callback));
  }

  /**
   * Parse a file chunkwise.
   * @param fileLinesSet The set of chunkified file lines.
   * @param mode The mode (first, second, third).
   * @param callback The post-parsing callback.
   */
  private parseFileRecursively(
      fileLinesSet: FileLine[][], mode: number, callback: () => void) {
    const filesLines: FileLine[]|undefined = fileLinesSet.pop();

    if (filesLines === undefined) {
      throw new Error('Failed to parse file lines');
    }

    for (const fileLine of filesLines) {
      this.processLine(fileLine.line, fileLine.op, fileLine.args, mode);
    }

    if (fileLinesSet.length) {
      this.config.chunkCallback(
          () => this.parseFileRecursively(fileLinesSet, mode, callback));
    } else {
      if (mode === ModeEnum.FIRST) {
        this.totalTime = this.timestamp + 1;
      } else {
        this.handleTimestamp(this.totalTime);
      }
      callback();
    }
  }

  /**
   * Parse a single line.
   * @param line The full line.
   * @param op The opcode.
   * @param args The arguments to the opcode.
   * @param mode The parse mode (first, second, third).
   */
  private processLine(line: string, op: string, args: string[], mode: number):
      void {
    switch (op) {
      // Version opcode
      case 'v': {
        if (args.length !== 1 && args.length !== 2) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode v');
        }

        let fileVersion: number;

        const heaptrackVersion = parseInt(args[0], 16);
        if (args.length < 2 && heaptrackVersion === 0x010200) {
          fileVersion = 1;
        } else {
          fileVersion = parseInt(args[1], 16);
        }

        if (this.config.supportedFileVersions.indexOf(fileVersion) === -1) {
          throw new Error(
              `Heaptrack file version not supported: ${fileVersion}`);
        }

        break;
      }

      // Executable opcode
      case 'X': {
        if (args.length !== 1) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode X');
        }

        if (this.executableFound) {
          throw new Error(
              'Failed to parse heaptrack file: multiple executable statements');
        }

        this.executableFound = true;

        if (mode !== ModeEnum.FIRST) {
          this.handleDebuggee(args[0]);
        }
        break;
      }

      // System info opcode
      case 'I': {
        if (args.length !== 2) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode I');
        }
        break;
      }

      // String opcode
      case 's': {
        if (mode !== ModeEnum.FIRST) {
          break;
        }

        const theString: string = line.substr(2);
        this.strings.push(theString);

        const newIndex = this.newStrings.indexOf(theString);
        const stopIndex = this.stopStrings.indexOf(theString);

        if (newIndex > -1) {
          this.newStrIndices.push(this.strings.length);
          this.newStrings.splice(newIndex, 1)
        } else if (stopIndex > -1) {
          this.stopIndices.push(this.strings.length);
          this.stopStrings.splice(stopIndex, 1)
        }

        break;
      }

      // Trace opcode
      case 't': {
        if (mode !== ModeEnum.FIRST) {
          break;
        }

        if (args.length !== 2) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode t');
        }
        let node: TraceNode = {
          ipIndex: parseInt(args[0], 16),
          parentIndex: parseInt(args[1], 16)
        };

        if (node.ipIndex !== null) {
          while (this.newIpIndices.indexOf(node.ipIndex) > -1) {
            if (node.parentIndex === null) {
              break;
            }
            node = this.findTrace(node.parentIndex);
            if (node.ipIndex === null) {
              break;
            }
          }
        }

        this.traces.push(node);
        break;
      }

      // Instruction opcode
      case 'i': {
        if (mode !== ModeEnum.FIRST) {
          break;
        }

        if (args.length < 2) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode i');
        }

        const ip: InstructionPointer = {
          instructionPointer: args[0],
          moduleIndex: parseInt(args[1], 16),
          frame: {functionIndex: null, fileIndex: null, line: null},
          inlined: []
        };

        const readFrame = (frame: Frame, index: {i: number}): boolean => {
          if (args.length <= index.i) {
            return false;
          }
          frame.functionIndex = parseInt(args[index.i++], 16);

          if (args.length <= index.i) {
            return false;
          }
          frame.fileIndex = parseInt(args[index.i++], 16);

          if (args.length <= index.i) {
            return false;
          }
          frame.line = parseInt(args[index.i++], 16);
          return true;
        };

        const index = {i: 2};

        if (readFrame(ip.frame, index)) {
          const inlinedFrame:
              Frame = {functionIndex: null, fileIndex: null, line: null};
          while (readFrame(inlinedFrame, index)) {
            ip.inlined.push(inlinedFrame);
          }
        }

        this.instructionPointers.push(ip);

        if (ip.frame.functionIndex !== null) {
          if (this.newStrIndices.indexOf(ip.frame.functionIndex) > -1) {
            this.newIpIndices.push(this.instructionPointers.length);
          }
        }

        break;
      }

      // Allocation opcode
      case '+': {
        if (args.length !== 1) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode +');
        }

        const allocationIndex: number = parseInt(args[0], 16);

        if (allocationIndex > this.allocationInfos.length) {
          throw new Error(
              'Failed to parse heaptrack file: allocation index out of bounds');
        }

        const info: AllocationInfo = this.allocationInfos[allocationIndex];
        this.lastAllocationPtr = allocationIndex;

        if (mode !== ModeEnum.FIRST) {
          if (info.allocationIndex === null) {
            throw new Error('Failed to find allocation by null index');
          }

          const allocation: Allocation = this.allocations[info.allocationIndex];
          allocation.leaked += info.size;
          ++allocation.allocations;
          this.handleAllocation(info, allocationIndex);
        }

        ++this.totalCost.allocations;
        this.totalCost.allocated += info.size;
        this.totalCost.leaked += info.size;
        if (this.totalCost.leaked > this.totalCost.peak) {
          this.totalCost.peak = this.totalCost.leaked;
          this.peakTime = this.timestamp;

          if (mode === ModeEnum.SECOND &&
              this.totalCost.peak === this.lastPeakCost &&
              this.peakTime === this.lastPeakTime) {
            this.allocations.forEach(
                allocation => allocation.peak = allocation.leaked);
          }
        }

        break;
      }

      // Deallocation opcode
      case '-': {
        if (args.length !== 1) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode -');
        }

        const allocationInfoIndex: number = parseInt(args[0], 16);
        let temporary = (this.lastAllocationPtr === allocationInfoIndex);
        this.lastAllocationPtr = 0;

        const info: AllocationInfo = this.allocationInfos[allocationInfoIndex];
        this.totalCost.leaked -= info.size;

        if (temporary) {
          ++this.totalCost.temporary;
        }

        if (mode !== ModeEnum.FIRST) {
          if (info.allocationIndex === null) {
            throw new Error('Failed to find allocation by null index');
          }
          const allocation = this.allocations[info.allocationIndex];
          allocation.leaked -= info.size;
          if (temporary) {
            ++allocation.temporary;
          }
        }

        break;
      }

      // Allocation opcode
      case 'a': {
        if (mode !== ModeEnum.FIRST) {
          break;
        }

        if (args.length !== 2) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode a');
        }

        const info: AllocationInfo = {
          size: parseInt(args[0], 16),
          allocationIndex: null
        };
        info.allocationIndex = this.mapToAllocationIndex(parseInt(args[1], 16));
        this.allocationInfos.push(info);
        break;
      }

      // Comment opcode
      case '':
      case '#':
        break;

      // Timestamp opcode
      case 'c': {
        if (args.length !== 1) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode c');
        }

        this.timestamp = parseInt(args[0], 16);
        if (mode !== ModeEnum.FIRST) {
          this.handleTimestamp(this.timestamp);
        }
        break;
      }

      // Timestamp opcode
      case 'R': {
        if (args.length !== 1) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode R');
        }

        const rss = parseInt(args[0], 16);

        if (rss > this.peakRss) {
          this.peakRss = rss;
        }
        break;
      }

      // Attached opcode
      case 'A': {
        if (args.length !== 0) {
          throw new Error(
              'Failed to parse heaptrack file: unexpected number of arguments to opcode A');
        }

        this.totalCost =
            {allocations: 0, allocated: 0, leaked: 0, peak: 0, temporary: 0};
        this.fromAttached = true;
        break;
      }

      // Unknown opcode
      default: {
        throw new Error(
            `Failed to parse heaptrack file: unknown opcode '${op}'`);
      }
    }
  }

  /**
   * Map from a trace index to an allocation index.
   * @param traceIndex The trace index.
   * @return The allocation index.
   */
  private mapToAllocationIndex(traceIndex: number): number {
    let allocationIndex: number|null = null;

    if (traceIndex < this.maxAllocationIndex) {
      const mapIndex = this.traceIndexToAllocationIndex.get(traceIndex);
      if (mapIndex) {
        return mapIndex;
      }

      allocationIndex = this.allocations.length;
      this.traceIndexToAllocationIndex.set(traceIndex, allocationIndex);

      const allocation: Allocation = {
        allocations: 0,
        temporary: 0,
        leaked: 0,
        peak: 0,
        traceIndex: traceIndex
      };
      this.allocations.push(allocation);
    } else if (
        traceIndex === this.maxAllocationIndex && this.allocations.length) {
      if (this.allocations[this.allocations.length - 1].traceIndex !==
          traceIndex) {
        throw new Error(
            'Failed to parse heaptrack file: trace indices did not match');
      }
      allocationIndex = this.allocations.length - 1;
    } else {
      allocationIndex = this.allocations.length;
      this.traceIndexToAllocationIndex.set(traceIndex, allocationIndex);

      const allocation: Allocation = {
        allocations: 0,
        temporary: 0,
        leaked: 0,
        peak: 0,
        traceIndex: traceIndex
      };
      this.allocations.push(allocation);
      this.maxAllocationIndex = traceIndex;
    }

    return allocationIndex;
  }

  /**
   * Locate a trace node from an index.
   * @param traceIndex The trace index.
   * @return The trace node.
   */
  private findTrace(traceIndex: number): TraceNode {
    return this.traces[traceIndex - 1];
  }

  /**
   * Prepare the charts for being populated during the third pass.
   */
  private prepareCharts(): void {
    this.buildCharts = true;

    this.consumedChartData.rows.push(
        {timestamp: 0, cost: new Array(this.config.maxNumCost).fill(0)});
    this.allocationsChartData.rows.push(
        {timestamp: 0, cost: new Array(this.config.maxNumCost).fill(0)});
    this.temporaryChartData.rows.push(
        {timestamp: 0, cost: new Array(this.config.maxNumCost).fill(0)});

    this.consumedChartData.labels.set(0, 'total');
    this.allocationsChartData.labels.set(0, 'total');
    this.temporaryChartData.labels.set(0, 'total');

    this.maxConsumedSinceLastTimeStamp = 0;
    const merged = new Map<number, ChartMergeData>();

    for (const alloc of this.allocations) {
      const ip: number|null = this.findTrace(alloc.traceIndex).ipIndex;

      if (ip === null) {
        throw new Error('Failed to find allocation trace with null index');
      }

      let entry = merged.get(ip);

      if (!entry) {
        entry = {ip: ip, consumed: 0, allocations: 0, temporary: 0};
        merged.set(ip, entry);
      }

      entry.consumed += alloc.peak;
      entry.allocations += alloc.allocations;
      entry.temporary += alloc.temporary;
    }

    let mergedArray: [number, ChartMergeData][] = Array.from(merged);
    this.prepareChart(
        mergedArray, this.consumedChartData, (obj: any) => obj.consumed,
        (obj: any, value: number) => obj.consumed = value);
    this.prepareChart(
        mergedArray, this.allocationsChartData, (obj: any) => obj.allocations,
        (obj: any, value: number) => obj.allocations = value);
    this.prepareChart(
        mergedArray, this.temporaryChartData, (obj: any) => obj.temporary,
        (obj: any, value: number) => obj.temporary = value);
  }

  /**
   * Prepare a single chart for being populated during the third pass.
   * @param mergedArray The array created from the merge map.
   * @param chart The chart to prepare.
   * @param propertyGetter A getter for the chart cost property.
   * @param propertySetter An setter for the chart cost property.
   */
  private prepareChart(
      mergedArray: [number, ChartMergeData][], chart: Chart,
      propertyGetter: (obj: any) => number,
      propertySetter: (obj: any, value: number) => void): void {
    mergedArray.sort((lhs, rhs) => {
      return propertyGetter(rhs[1]) - propertyGetter(lhs[1]);
    });

    for (let i = 0; i < mergedArray.length && i < this.config.maxNumCost - 1;
         ++i) {
      const ip: number = mergedArray[i][1].ip;
      let labelIds: LabelIds|undefined = this.labelIds.get(ip);

      if (labelIds === undefined) {
        labelIds = {consumed: -1, allocations: -1, temporary: -1};
        this.labelIds.set(ip, labelIds);
      }

      propertySetter(labelIds, i + 1);
      const instructionPointer: InstructionPointer|null = this.findIp(ip);
      if (instructionPointer === null) {
        throw new Error('Failed to get instruction pointer');
      }
      const frame: Frame = instructionPointer.frame;

      if (frame.functionIndex !== null) {  // ATTN check this logic
        const functionName: string = frame.functionIndex < this.strings.length ?
            this.stringify(frame.functionIndex) :
            '';
        chart.labels.set(i + 1, functionName);
      }
    }
  }

  /**
   * Find an instruction pointer given the index.
   * @param ipIndex The index.
   * @return The instruction pointer if one can be found, otherwise null.
   */
  private findIp(ipIndex: number): InstructionPointer|null {
    if (ipIndex > this.instructionPointers.length) {
      return null;
    }
    return this.instructionPointers[ipIndex - 1];
  }

  /**
   * Merge matching allocations.
   * @return The top rows of the merged allocations and the caller-callee
   * results.
   */
  private mergeAllocations():
      {topRows: RowData[], callerCalleeResults: CallerCalleeResults} {
    const callerCalleeResults: CallerCalleeResults = {
      entries: new Map<Symbol, CallerCalleeEntry>(),
      totalCosts: {allocations: 0, temporary: 0, leaked: 0, peak: 0}
    };

    const topRows: RowData[] = [];
    let symbolRecursionGuard: Symbol[] = [];

    const addRow = (rows: RowData[], location: Location, cost: Allocation):
        RowData[] => {
          let foundRow: RowData|null =
              this.findFirstSymbol(rows, location.symbol);
          if (foundRow !== null) {
            foundRow.cost.allocations += cost.allocations;
            foundRow.cost.leaked += cost.leaked;
            foundRow.cost.peak += cost.peak;
            foundRow.cost.temporary += cost.temporary;
          }

          else {
            foundRow = {
              cost: {
                allocations: cost.allocations,
                leaked: cost.leaked,
                temporary: cost.temporary,
                peak: cost.peak
              },
              symbol: location.symbol,
              parent: null,
              children: []
            };
            rows.push(foundRow);
          }

          this.addCallerCalleeEvent(
              location, cost, symbolRecursionGuard, callerCalleeResults);
          return foundRow.children;
        }

    for (const allocation of this.allocations) {
      let traceIndex: number|null = allocation.traceIndex;
      let rows = topRows;
      const recursionGuard: number[] = [];
      recursionGuard.push(traceIndex);
      symbolRecursionGuard = [];

      while (traceIndex) {
        const trace: TraceNode = this.findTrace(traceIndex);

        if (trace.ipIndex === null) {
          throw new Error('Failed to get trace IP index');
        }
        const ip: InstructionPointer|null = this.findIp(trace.ipIndex);
        if (ip === null) {
          throw new Error('Failed to get instruction pointer');
        }

        const location = this.strLocation(ip);
        rows = addRow(rows, location, allocation);

        for (const inlined of ip.inlined) {
          const inlinedLocation =
              this.strFrameLocation(inlined, ip.moduleIndex);
          rows = addRow(rows, inlinedLocation, allocation);
        }

        if (ip.frame.functionIndex === null) {
          break;  // throw new Error('Failed to find frame function index');
                  // // ATTN check this logic
        }

        if (this.stopIndices.indexOf(ip.frame.functionIndex) > -1) {
          break;
        }
        traceIndex = trace.parentIndex;
        if (traceIndex === null) {
          break;
        }
        if (recursionGuard.indexOf(traceIndex) > -1) {
          console.warn('Trace recursion detected - corrupt data file?');
          break;
        }
        recursionGuard.push(traceIndex);
      }
    }

    this.setParents(topRows, null);
    return {topRows, callerCalleeResults};
  }

  /**
   * Set the parents of a set of children.
   * @param children The children.
   * @param parent The parent (can be null).
   */
  private setParents(children: RowData[], parent: RowData|null): void {
    for (const row of children) {
      row.parent = parent;
      this.setParents(row.children, row);
    }
  }

  /**
   * Add a caller-callee event.
   * @param location The children.
   * @param cost The cost.
   * @param recursionGuard The recursion guard.
   * @param callerCalleeResult The caller-callee result.
   */
  private addCallerCalleeEvent(
      location: Location, cost: AllocationData, recursionGuard: Symbol[],
      callerCalleeResult: CallerCalleeResults): void {
    const index: number = recursionGuard.indexOf(location.symbol);
    if (index > -1) {
      return;
    }

    let entry: CallerCalleeEntry|undefined =
        callerCalleeResult.entries.get(location.symbol);

    if (!entry) {
      entry = {
        callers: new Map<Symbol, AllocationData>(),
        callees: new Map<Symbol, AllocationData>(),
        sourceMap: new Map<number, EntryCost>(),
        inclusiveCost: {allocations: 0, temporary: 0, leaked: 0, peak: 0},
        selfCost: {allocations: 0, temporary: 0, leaked: 0, peak: 0}
      };

      callerCalleeResult.entries.set(location.symbol, entry);
    }

    let locationCost: EntryCost|undefined;

    if (location.fileLine === null) {
      return;  // throw new Error('Location file line was null'); // ATTN
               // check this logic
    }

    locationCost = entry.sourceMap.get(location.fileLine);

    if (locationCost === undefined) {
      locationCost = {
        inclusiveCost: {allocations: 0, temporary: 0, leaked: 0, peak: 0},
        selfCost: {allocations: 0, temporary: 0, leaked: 0, peak: 0}
      };
      entry.sourceMap.set(location.fileLine, locationCost);
    }

    locationCost.inclusiveCost.allocations += cost.allocations;
    locationCost.inclusiveCost.leaked += cost.leaked;
    locationCost.inclusiveCost.peak += cost.peak;
    locationCost.inclusiveCost.temporary += cost.temporary;

    if (!recursionGuard.length) {
      locationCost.selfCost.allocations += cost.allocations;
      locationCost.selfCost.leaked += cost.leaked;
      locationCost.selfCost.peak += cost.peak;
      locationCost.selfCost.temporary += cost.temporary;
    }

    recursionGuard.push(location.symbol);
  }

  /**
   * Find the first row with a symbol matching the given symbol.
   * @param rows The rows.
   * @param symbol The symbol.
   * @return The row if one is found, otherwise null.
   */
  private findFirstSymbol(rows: RowData[], symbol: Symbol): RowData|null {
    for (const row of rows) {
      if (row.symbol.symbol !== symbol.symbol) {
        continue;
      }
      if (row.symbol.path !== symbol.path) {
        continue;
      }
      if (row.symbol.binary !== symbol.binary) {
        continue;
      }
      return row;
    }

    return null;
  }

  /**
   * Find a location from the string referred to by an instruction pointer.
   * @param ip The instruction pointer.
   * @return The location.
   */
  private strLocation(ip: InstructionPointer): Location {
    return this.strFrameLocation(ip.frame, ip.moduleIndex);
  }

  /**
   * Find a string from an index.
   * @param index The index.
   * @return The string if one exists, otherwise an empty string.
   */
  private stringify(index: number): string {
    if (index < 1 || index > this.strings.length) {
      return '';
    }
    return this.strings[index - 1];
  }

  /**
   * Find a location from a frame and module index.
   * @param frame The frame.
   * @param moduleIndex The module index.
   * @return The location.
   */
  private strFrameLocation(frame: Frame, moduleIndex: number): Location {
    const moduleName: string = this.stringify(moduleIndex);
    let binary: string|undefined = this.pathToBinaries.get(moduleName);

    if (!binary) {
      binary = this.basename(moduleName);
      this.pathToBinaries.set(moduleName, binary);
    }

    return {
      symbol: {symbol: this.strFunc(frame), binary: binary, path: moduleName},
      fileLine: frame.line
    };
  }

  /**
   * Find a function name from a frame.
   * @param frame The frame.
   * @param moduleIndex The module index.
   * @return The function name if there is one, otherwise '<unresolved
   * function>'.
   */
  private strFunc(frame: Frame): string {
    if (frame.functionIndex === null) {
      return '<unresolved function>';
    }

    return this.stringify(frame.functionIndex);
  }

  /**
   * Get the basename from a path.
   * @param path The path.
   * @return The basename.
   */
  private basename(path: string): string {
    const index: number = path.lastIndexOf('/');
    return path.substr(index + 1);
  }

  /**
   * Build an allocation size histogram.
   */
  private buildSizeHistogram(): void {
    return;  // (TODO: write this function).
  }

  /**
   * Convert bottom-down row data to top-down row data.
   * @param bottomDownData The bottom-down row data.
   * @return The top-down row data.
   */
  private toTopDownData(bottomDownData: RowData[]): RowData[] {
    const topRows: RowData[] = [];
    this.buildTopDown(bottomDownData, topRows);
    this.setParents(topRows, null);
    return topRows;
  }

  /**
   * Test whether two allocation data objects are equivalent.
   * @param lhs The LHS allocation data.
   * @param rhs The RHS allocation data.
   * @return Whether they are equivalent.
   */
  private allocationDataEquivalent(lhs: AllocationData, rhs: AllocationData):
      boolean {
    if (lhs.allocations !== rhs.allocations) {
      return false;
    }
    if (lhs.leaked !== rhs.leaked) {
      return false;
    }
    if (lhs.temporary !== rhs.temporary) {
      return false;
    }
    if (lhs.peak !== rhs.peak) {
      return false;
    }
    return true;
  }

  /**
   * Produce an allocation data object that is the fieldwise sum of two such
   * objects.
   * @param lhs The LHS allocation data.
   * @param rhs The RHS allocation data.
   * @return The combined allocation data.
   */
  private combineAllocationData(lhs: AllocationData, rhs: AllocationData):
      AllocationData {
    return {
      allocations: lhs.allocations + rhs.allocations,
      temporary: lhs.temporary + rhs.temporary,
      peak: lhs.peak + rhs.peak,
      leaked: lhs.leaked + rhs.leaked
    };
  }

  /**
   * Produce an allocation data object that is the fieldwise difference of two
   * such objects.
   * @param lhs The LHS allocation data.
   * @param rhs The RHS allocation data.
   * @return The subtracted allocation data.
   */
  private subtractAllocationData(lhs: AllocationData, rhs: AllocationData):
      AllocationData {
    return {
      allocations: lhs.allocations - rhs.allocations,
      temporary: lhs.temporary - rhs.temporary,
      peak: lhs.peak - rhs.peak,
      leaked: lhs.leaked - rhs.leaked
    };
  }

  /**
   * Build top-down data from bottom-down data.
   * @param bottomDownData The bottom-down row data.
   * @param topDownData The top-down row data.
   * @return The allocation data.
   */
  private buildTopDown(bottomDownData: RowData[], topDownData: RowData[]):
      AllocationData {
    let totalCost:
        AllocationData = {allocations: 0, temporary: 0, leaked: 0, peak: 0};

    for (const row of bottomDownData) {
      const childCost: AllocationData =
          this.buildTopDown(row.children, topDownData);

      if (!this.allocationDataEquivalent(childCost, row.cost)) {
        const cost: AllocationData =
            this.subtractAllocationData(row.cost, childCost);
        let node: RowData|null = row;
        let stack: RowData[] = topDownData;

        while (node !== null) {
          let data: RowData|null = this.findFirstSymbol(stack, node.symbol);
          if (data === null) {
            data = {
              cost: {allocations: 0, leaked: 0, peak: 0, temporary: 0},
              symbol: node.symbol,
              parent: null,
              children: []
            };
            stack.push(data);
          }

          data.cost = this.combineAllocationData(data.cost, cost);
          stack = data.children;
          node = node.parent;
        }
      }

      totalCost = this.combineAllocationData(totalCost, row.cost);
    }

    return totalCost;
  }

  /**
   * Write caller-callee data.
   * @param topRows The top row data rows.
   * @param callerCalleeResults The caller-callee results.
   */
  private writeCallerCalleeData(
      topRows: RowData[], callerCalleeResults: CallerCalleeResults): void {
    return;  // TODO: write this function
  }

  /**
   * Callback for handling timestamp data.
   * @param timestamp The timestamp value.
   */
  private handleTimestamp(timestamp: number): void {
    if (!this.buildCharts) {
      return;
    }

    this.maxConsumedSinceLastTimeStamp =
        Math.max(this.maxConsumedSinceLastTimeStamp, this.totalCost.leaked);

    const diffBetweenTimeStamps: number =
        this.totalTime / this.config.maxDataPoints;
    if (timestamp !== this.totalTime &&
        timestamp - this.lastTimestamp < diffBetweenTimeStamps) {
      return;
    }

    const nowConsumed: number = this.maxConsumedSinceLastTimeStamp;
    this.maxConsumedSinceLastTimeStamp = 0;
    this.lastTimestamp = timestamp;

    const createRow = (timestamp: number, totalCost: number): ChartRow => {
      const row: ChartRow = {
        timestamp: timestamp,
        cost: new Array(this.config.maxNumCost)
      };
      row.cost[0] = totalCost;
      for (let i = 1; i < row.cost.length; ++i) {
        row.cost[i] = 0;
      }
      return row;
    };

    const consumed: ChartRow = createRow(timestamp, nowConsumed);
    const allocs: ChartRow = createRow(timestamp, this.totalCost.allocations);
    const temporary: ChartRow = createRow(timestamp, this.totalCost.temporary);

    const addDataToRow = (cost: number, labelId: number, rows: ChartRow) => {
      if (!cost || labelId === -1 || labelId >= this.config.maxNumCost) {
        return;
      }
      rows.cost[labelId] += cost;
    };

    for (const alloc of this.allocations) {
      const ip: number|null = this.findTrace(alloc.traceIndex).ipIndex;

      if (ip === null) {
        throw new Error('Allocation instruction pointer was null');
      }
      const labels = this.labelIds.get(ip);
      if (!labels) {
        continue;
      }

      addDataToRow(alloc.leaked, labels.consumed, consumed);
      addDataToRow(alloc.allocations, labels.allocations, allocs);
      addDataToRow(alloc.temporary, labels.temporary, temporary);
    }

    this.consumedChartData.rows.push(consumed);
    this.allocationsChartData.rows.push(allocs);
    this.temporaryChartData.rows.push(temporary);
  }

  /**
   * Callback for handling allocation data.
   * @param info The allocation info.
   * @param index The index.
   */
  private handleAllocation(info: AllocationInfo, index: number): void {
    this.maxConsumedSinceLastTimeStamp =
        Math.max(this.maxConsumedSinceLastTimeStamp, this.totalCost.leaked);

    if (index === this.allocationInfoCounter.length) {
      this.allocationInfoCounter.push({info: info, allocations: 1});
    } else {
      ++this.allocationInfoCounter[index].allocations;
    }
  }

  /**
   * Callback for handling debuggee data.
   * @param command The command string.
   */
  private handleDebuggee(command: string): void {
    this.debuggee = command;
  }
}