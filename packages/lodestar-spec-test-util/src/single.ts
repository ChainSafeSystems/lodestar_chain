/* eslint-disable @typescript-eslint/no-explicit-any */
import {expect} from "chai";
import {readdirSync, readFileSync, writeFile} from "fs";
import {basename, join, parse} from "path";
import profiler from "v8-profiler-next";
import {Type, CompositeType} from "@chainsafe/ssz";

import {isDirectory, loadYamlFile} from "./util";

export enum InputType {
  SSZ = "ssz",
  YAML = "yaml",
}

export type ExpandedInputType = {
  type: InputType;
  treeBacked: boolean;
};

export function toExpandedInputType(inputType: InputType | ExpandedInputType): ExpandedInputType {
  if ((inputType as ExpandedInputType).type) {
    return inputType as ExpandedInputType;
  }
  return {
    type: inputType as InputType,
    treeBacked: false,
  };
}

export interface ISpecTestOptions<TestCase, Result> {
  /**
   * If directory contains both ssz or yaml file version,
   * you can choose which one to use. Default is ssz.
   */
  inputTypes?: {[K in keyof NonNullable<TestCase>]?: InputType | ExpandedInputType};

  sszTypes?: {[K in keyof NonNullable<TestCase>]?: Type<any>};

  /**
   * Optionally
   * @param testCase
   */
  getExpected?: (testCase: TestCase) => Result | undefined;

  /**
   * Optionally pass function to transform loaded values
   * (values from input files)
   */
  inputProcessing?: {[K: string]: (value: any) => any};

  shouldError?: (testCase: TestCase) => boolean;

  shouldSkip?: (testCase: TestCase, name: string, index: number) => boolean;

  expectFunc?: (testCase: TestCase, expected: any, actual: any) => void;

  timeout?: number;
}

export interface ITestCaseMeta {
  directoryName: string;
}

const defaultOptions: ISpecTestOptions<any, any> = {
  inputTypes: {},
  inputProcessing: {},
  sszTypes: {},
  getExpected: (testCase) => testCase,
  shouldError: () => false,
  shouldSkip: () => false,
  expectFunc: (testCase, expected, actual) => expect(actual).to.be.deep.equal(expected),
  timeout: 10 * 60 * 1000,
};

export function describeDirectorySpecTest<TestCase, Result>(
  name: string,
  testCaseDirectoryPath: string,
  testFunction: (testCase: TestCase, directoryName: string) => Result,
  options: Partial<ISpecTestOptions<TestCase, Result>>
): void {
  options = {...defaultOptions, ...options};
  if (!isDirectory(testCaseDirectoryPath)) {
    throw new Error(`${testCaseDirectoryPath} is not directory`);
  }
  describe(name, function () {
    if (options.timeout) {
      this.timeout(options.timeout || "10 min");
    }

    const testCases = readdirSync(testCaseDirectoryPath)
      .map((name) => join(testCaseDirectoryPath, name))
      .filter(isDirectory);

    for (const [index, testCaseDirectory] of testCases.entries()) {
      generateTestCase(testCaseDirectory, index, testFunction, options);
    }
  });
}

function generateTestCase<TestCase, Result>(
  testCaseDirectoryPath: string,
  index: number,
  testFunction: (...args: any) => Result,
  options: ISpecTestOptions<TestCase, Result>
): void {
  const name = basename(testCaseDirectoryPath);
  it(name, function () {
    const testCase = loadInputFiles(testCaseDirectoryPath, options);
    if (options.shouldSkip && options.shouldSkip(testCase, name, index)) {
      this.skip();
      return;
    }
    if (options.shouldError && options.shouldError(testCase)) {
      try {
        testFunction(testCase, name);
      } catch (e: unknown) {
        return;
      }
    } else {
      const profileId = `${name}-${Date.now()}.profile`;
      const profilingDirectory = process.env.GEN_PROFILE_DIR;
      if (profilingDirectory) {
        profiler.startProfiling(profileId);
      }
      const result = testFunction(testCase, name);
      if (profilingDirectory) {
        const profile = profiler.stopProfiling(profileId);

        generateProfileReport(profile, profilingDirectory, profileId);
      }
      if (!options.getExpected) throw Error("getExpected is not defined");
      if (!options.expectFunc) throw Error("expectFunc is not defined");
      const expected = options.getExpected(testCase);
      options.expectFunc(testCase, expected, result);
    }
  });
}

function loadInputFiles<TestCase, Result>(directory: string, options: ISpecTestOptions<TestCase, Result>): TestCase {
  const testCase: any = {};
  readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((file) => {
      if (isDirectory(file)) {
        return false;
      }
      if (!options.inputTypes) throw Error("inputTypes is not defined");
      const name = parse(file).name as keyof NonNullable<TestCase>;
      const inputType = toExpandedInputType(options.inputTypes[name] ?? InputType.SSZ);
      // set options.inputTypes[name] with expanded input type
      options.inputTypes[name] = inputType;
      const extension = inputType.type as string;
      return file.endsWith(extension);
    })
    .forEach((file) => {
      const inputName = basename(file).replace(".ssz", "").replace(".yaml", "");
      testCase[inputName] = deserializeTestCase(file, inputName, options);
      if (file.endsWith(InputType.SSZ)) {
        testCase[`${inputName}_raw`] = readFileSync(file);
      }
      if (!options.inputProcessing) throw Error("inputProcessing is not defined");
      if (options.inputProcessing[inputName]) {
        testCase[inputName] = options.inputProcessing[inputName](testCase[inputName]);
      }
    });
  return testCase as TestCase;
}

function deserializeTestCase<TestCase, Result>(
  file: string,
  inputName: string,
  options: ISpecTestOptions<TestCase, Result>
): Record<string, unknown> {
  if (file.endsWith(InputType.SSZ)) {
    if (!options.sszTypes) throw Error("sszTypes is not defined");
    const data = readFileSync(file);
    if ((options.inputTypes![inputName as keyof TestCase]! as ExpandedInputType).treeBacked) {
      return (options.sszTypes[inputName as keyof NonNullable<TestCase>] as CompositeType<any>).tree.deserialize(data);
    } else {
      return options.sszTypes[inputName as keyof NonNullable<TestCase>]?.deserialize(data);
    }
  } else {
    return loadYamlFile(file);
  }
}

function generateProfileReport(profile: profiler.CpuProfile, directory: string, profileId: string): void {
  profile.export((error, result) => {
    if (error || result === undefined) {
      return;
    }
    writeFile(`${directory}/${profileId}`, result as string, () => {
      profile.delete();
    });
  });
}
