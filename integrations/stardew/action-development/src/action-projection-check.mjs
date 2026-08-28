import {
  ACTION_SURFACE_GAME_ID,
  ACTION_SURFACE_SCHEMA,
  ACTION_SURFACE_MAX_ARRAY_ITEMS,
  ACTION_SURFACE_MAX_IDENTIFIER_LENGTH,
  isActionSurfaceIdentifier,
  parseActionSurface,
  validateActionSurface,
} from "./action-surface.mjs";

const ERROR_PREFIX = "stardew_action_projection";
const MAX_DESCRIPTOR_KEYS = 32;
const DESCRIPTOR_KEYS = Object.freeze(["actionId"]);

function fail(code) {
  throw new Error(`${ERROR_PREFIX}_${code}`);
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function descriptorOf(value, key, code) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(code);
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) {
    fail(code);
  }
  return descriptor;
}

function ownStringKeys(value, code) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (keys.some((key) => typeof key !== "string")) fail(code);
  return keys;
}

function exactDescriptorShape(value) {
  const keys = ownStringKeys(value, "invalid_descriptor");
  if (keys.length > MAX_DESCRIPTOR_KEYS) fail("descriptor_bounds");
  if (!keys.includes("actionId")) fail("descriptor_shape");
  descriptorOf(value, "actionId", "descriptor_shape");

  // Descriptor metadata is deliberately opaque to this consumer. Reading it
  // cannot add registration identity or override source-owned registration
  // fields. Accessors and non-enumerable properties are still rejected.
  for (const key of keys) {
    const descriptor = descriptorOf(value, key, "invalid_descriptor");
    if (!descriptor.enumerable) fail("invalid_descriptor");
  }
  try {
    structuredClone(value);
  } catch {
    fail("invalid_descriptor");
  }
}

function descriptorActionIds(descriptors) {
  if (descriptors === undefined) return null;
  if (!Array.isArray(descriptors) || descriptors.length > ACTION_SURFACE_MAX_ARRAY_ITEMS) {
    fail("invalid_descriptors");
  }

  const ids = new Set();
  for (const descriptor of descriptors) {
    let actionId;
    if (typeof descriptor === "string") {
      actionId = descriptor;
    } else {
      if (!isObject(descriptor) || Array.isArray(descriptor) || Object.getPrototypeOf(descriptor) !== Object.prototype) {
        fail("invalid_descriptor");
      }
      exactDescriptorShape(descriptor);
      actionId = descriptorOf(descriptor, "actionId", "descriptor_shape").value;
    }
    if (!isActionSurfaceIdentifier(actionId) || actionId.length > ACTION_SURFACE_MAX_IDENTIFIER_LENGTH) {
      fail("invalid_descriptor_action_id");
    }
    if (ids.has(actionId)) fail("duplicate_descriptor_action_id");
    ids.add(actionId);
  }
  return ids;
}

function normalizeDescriptors(options) {
  if (options === undefined) return undefined;
  if (Array.isArray(options)) return options;
  if (!isObject(options) || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    fail("invalid_projection_options");
  }
  const keys = ownStringKeys(options, "invalid_projection_options");
  if (keys.length !== 1 || !keys.includes("descriptors")) fail("invalid_projection_options_shape");
  return descriptorOf(options, "descriptors", "invalid_projection_options_shape").value;
}

function sourceRegistrations(input) {
  if (typeof input === "string") return parseActionSurface(input);
  return validateActionSurface(input);
}

function isExecutable(registration) {
  return registration.lifecycle === "published" && registration.kind === "execution";
}

function freezeArray(values) {
  return Object.freeze([...values]);
}

/**
 * Project a static surface restrictively. The surface is the only source of
 * registrations; descriptor metadata may select existing IDs but can never
 * create, replace, or enrich a registration.
 */
export function projectActionSurface(input, options) {
  const surface = sourceRegistrations(input);
  const ids = descriptorActionIds(normalizeDescriptors(options));
  const registrations = ids === null
    ? surface.registrations
    : surface.registrations.filter((registration) => ids.has(registration.actionId));
  const executable = registrations.filter(isExecutable);
  const readOnly = registrations.filter((registration) => registration.kind === "read_only");

  // Keep all three arrays source-shaped. No descriptor-owned field crosses the
  // projection boundary, and executable is strictly a subset of registrations.
  return Object.freeze({
    schema: ACTION_SURFACE_SCHEMA,
    gameId: ACTION_SURFACE_GAME_ID,
    registrations: freezeArray(registrations),
    executable: freezeArray(executable),
    readOnly: freezeArray(readOnly),
  });
}

export function projectExecutableRegistrations(input, options) {
  return projectActionSurface(input, options).executable;
}

export function projectReadOnlyRegistrations(input, options) {
  return projectActionSurface(input, options).readOnly;
}

/**
 * Assert the restrictive projection laws and return the immutable projection.
 * This is a package-local consistency check, not a publication or authority
 * decision.
 */
export function validateActionProjection(input, options) {
  const projection = projectActionSurface(input, options);
  const sourceIds = new Set(projection.registrations.map((registration) => registration.actionId));
  for (const registration of projection.executable) {
    if (!sourceIds.has(registration.actionId) || registration.lifecycle !== "published" || registration.kind !== "execution") {
      fail("executable_projection_widened");
    }
  }
  for (const registration of projection.readOnly) {
    if (!sourceIds.has(registration.actionId) || registration.kind !== "read_only") {
      fail("readonly_projection_invalid");
    }
  }
  if (projection.executable.some((registration) => registration.kind === "read_only")) {
    fail("readonly_executable");
  }
  return projection;
}

export const checkActionProjection = validateActionProjection;
export const isExecutableActionRegistration = isExecutable;
export const ACTION_PROJECTION_DESCRIPTOR_KEYS = DESCRIPTOR_KEYS;
