import { lstat, realpath } from "node:fs/promises";
import { types } from "node:util";
import path from "node:path";

export const MAX_TEST_MODULES = 256;
export const MAX_TEST_MODULE_PATH_LENGTH = 512;

const TEST_MODULE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const TEST_MODULE_SUFFIX = ".test.mjs";

function fail(code) {
  throw new Error(`stardew_action_test_runner_${code}`);
}

function isPlainRecord(value) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  return true;
}

function readDataProperty(record, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
  return descriptor.value;
}

function validateOptions(input) {
  if (!isPlainRecord(input)) fail("invalid_options");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string" || (key !== "packageRoot" && key !== "testModules"))) {
    fail("invalid_options_shape");
  }
  return {
    packageRoot: readDataProperty(input, "packageRoot", "invalid_options_shape"),
    testModules: readDataProperty(input, "testModules", "invalid_options_shape"),
  };
}

function normalizePackageRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("invalid_package_root");
  return path.resolve(value);
}

function validateRelativeTestModule(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEST_MODULE_PATH_LENGTH) {
    fail("invalid_test_module_path");
  }
  if (value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    fail("invalid_test_module_path");
  }

  const segments = value.split("/");
  if (segments.length < 2 || segments[0] !== "tests" || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || !TEST_MODULE_SEGMENT.test(segment))) {
    fail("invalid_test_module_path");
  }
  if (!value.endsWith(TEST_MODULE_SUFFIX)) fail("invalid_test_module_path");
  if (path.posix.normalize(value) !== value) fail("invalid_test_module_path");
  return value;
}

function validateFrozenTestModules(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value)) {
    fail("test_modules_not_frozen");
  }
  if (!Number.isSafeInteger(value.length) || value.length === 0 || value.length > MAX_TEST_MODULES) {
    fail("invalid_test_module_count");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length") || keys.some((key) => key !== "length" && (!/^\d+$/.test(key) || Number(key) >= value.length))) {
    fail("invalid_test_modules_shape");
  }

  const modules = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("invalid_test_modules_shape");
    const modulePath = validateRelativeTestModule(descriptor.value);
    const duplicateKey = modulePath.toLowerCase();
    if (seen.has(duplicateKey)) fail("duplicate_test_module");
    seen.add(duplicateKey);
    modules.push(modulePath);
  }
  return modules;
}

function assertContained(root, candidate, code) {
  const relative = path.relative(root, candidate);
  if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) fail(code);
}

async function readLstat(candidate, missingCode, unreadableCode) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") fail(missingCode);
    fail(unreadableCode);
  }
}

function rejectLinkOrReparse(details, code = "path_link_or_reparse") {
  if (details.isSymbolicLink()) fail(code);
}

async function confirmPackageRoot(root) {
  const ancestors = [];
  let ancestor = root;
  while (true) {
    ancestors.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const candidate of ancestors) {
    const details = await readLstat(candidate, "package_root_missing", "package_root_unreadable");
    rejectLinkOrReparse(details, "package_root_link_or_reparse");
  }

  const details = await readLstat(root, "package_root_missing", "package_root_unreadable");
  if (!details.isDirectory()) fail("package_root_not_directory");

  let resolvedRoot;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    fail("package_root_unreadable");
  }
  return resolvedRoot;
}

async function validateTestModule(root, modulePath) {
  const candidate = path.resolve(root, ...modulePath.split("/"));
  assertContained(root, candidate, "test_module_outside_package");

  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const details = await readLstat(parent, "test_module_missing", "test_module_unreadable");
    rejectLinkOrReparse(details);
    if (!details.isDirectory()) fail("test_module_parent_not_directory");
  }

  const details = await readLstat(candidate, "test_module_missing", "test_module_unreadable");
  rejectLinkOrReparse(details);
  if (!details.isFile()) fail("test_module_not_regular_file");

  let physicalCandidate;
  try {
    physicalCandidate = await realpath(candidate);
  } catch {
    fail("test_module_unreadable");
  }
  assertContained(root, physicalCandidate, "test_module_outside_package");
  return candidate;
}

/**
 * Validates an explicit package-local test selection and builds, but does not run,
 * the corresponding direct Node test invocation.
 */
export async function buildPackageTestInvocation(input) {
  const { packageRoot, testModules } = validateOptions(input);
  const modules = validateFrozenTestModules(testModules);
  const lexicalRoot = normalizePackageRoot(packageRoot);
  const root = await confirmPackageRoot(lexicalRoot);
  const files = [];
  for (const modulePath of modules) files.push(await validateTestModule(root, modulePath));

  const args = Object.freeze(["--test", "--test-concurrency=1", ...files]);
  const policy = Object.freeze({
    shell: false,
    selection: "explicit-relative-test-modules",
    authority: "package-local-preparation",
  });
  return Object.freeze({
    command: process.execPath,
    args,
    cwd: root,
    shell: false,
    policy,
  });
}
