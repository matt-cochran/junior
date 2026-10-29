// ---------------------------------------------------------------------------
// Crossmatrix ADR-0004 Dimension set assembly, atomic writes and validation.
// This module is split out of matrix.ts per ADR 0016.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalJson,
  isRecord,
  sha256Hex,
  type DimensionsDocument,
  type MatrixDimension,
} from './matrix-adapters.ts';

// ---------------------------------------------------------------------------
// Dimension set assembly + atomic writes
// ---------------------------------------------------------------------------

/** Assemble a Dimensions document; the version hashes its canonical roster. */
export function buildDimensionSet(dimensionSetId: string, dimensions: MatrixDimension[]): DimensionsDocument {
  const version = sha256Hex(canonicalJson(dimensions)).slice(0, 12);
  return { schemaVersion: '0.2.0', dimensionSetId, version, dimensions };
}

/** Write `<dir>/dimensions/<dimensionSetId>@<version>.json` atomically. */
export function writeDimensionSet(dir: string, doc: DimensionsDocument): { path: string; unchanged: boolean } {
  const target = path.join(dir, 'dimensions', `${doc.dimensionSetId}@${doc.version}.json`);
  const bytes = `${canonicalJson(doc)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === bytes) {
    return { path: target, unchanged: true };
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
  return { path: target, unchanged: false };
}

// ---------------------------------------------------------------------------
// Schema subset validation (no dependency; mirrors the vendored schema)
// ---------------------------------------------------------------------------

const KIND_ENUM: readonly string[] = [
  'customer_requirement', 'engineering_characteristic', 'stakeholder_priority', 'option',
  'criterion', 'constraint', 'implementation_asset', 'test_artifact', 'business_metric',
  'failure_mode', 'jtbd_step', 'context', 'code_element',
];
const STATUS_ENUM: readonly string[] = ['active', 'deprecated'];
const TOP_KEYS = ['schemaVersion', 'dimensionSetId', 'version', 'label', 'dimensions'];
const DIM_KEYS = ['id', 'label', 'kind', 'order', 'system', 'weightSemantics', 'weightScale', 'members'];
const MEMBER_KEYS = ['id', 'label', 'weightObservation', 'weight', 'sourceRef', 'status', 'supersededBy', 'attributes'];
const SOURCE_REF_KEYS = ['system', 'sourceType', 'sourceRef', 'locator', 'contentHash', 'version', 'excerpt'];

function rejectUnknownKeys(record: Record<string, unknown>, allowed: string[], base: string, errors: string[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) errors.push(`${base}.${key}: unknown property`);
}

/** Check a document against the vendored schema's rules; return path errors. */
export function validateDimensionSet(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(doc)) return ['$: expected object'];

  for (const key of ['schemaVersion', 'dimensionSetId', 'version', 'dimensions']) {
    if (!(key in doc)) errors.push(`$.${key}: required property missing`);
  }
  rejectUnknownKeys(doc, TOP_KEYS, '$', errors);

  if (doc.dimensions !== undefined && !Array.isArray(doc.dimensions)) {
    errors.push('$.dimensions: expected array');
    return errors;
  }

  const dimensions = Array.isArray(doc.dimensions) ? doc.dimensions : [];
  dimensions.forEach((dimension, di) => {
    const base = `$.dimensions[${di}]`;
    if (!isRecord(dimension)) {
      errors.push(`${base}: expected object`);
      return;
    }
    for (const key of ['id', 'order', 'members']) {
      if (!(key in dimension)) errors.push(`${base}.${key}: required property missing`);
    }
    rejectUnknownKeys(dimension, DIM_KEYS, base, errors);
    if (dimension.kind !== undefined && !KIND_ENUM.includes(String(dimension.kind))) {
      errors.push(`${base}.kind: unknown dimension kind '${String(dimension.kind)}'`);
    }
    if (dimension.order !== undefined && (!Number.isInteger(dimension.order) || dimension.order < 0)) {
      errors.push(`${base}.order: expected a non-negative integer`);
    }
    if (dimension.members !== undefined && !Array.isArray(dimension.members)) {
      errors.push(`${base}.members: expected array`);
      return;
    }
    const members = Array.isArray(dimension.members) ? dimension.members : [];
    members.forEach((member, mi) => {
      const memberBase = `${base}.members[${mi}]`;
      if (!isRecord(member)) {
        errors.push(`${memberBase}: expected object`);
        return;
      }
      if (!('id' in member)) errors.push(`${memberBase}.id: required property missing`);
      rejectUnknownKeys(member, MEMBER_KEYS, memberBase, errors);
      if (member.status !== undefined && !STATUS_ENUM.includes(String(member.status))) {
        errors.push(`${memberBase}.status: unknown lifecycle status '${String(member.status)}'`);
      }
      if (member.sourceRef !== undefined) {
        if (!isRecord(member.sourceRef)) {
          errors.push(`${memberBase}.sourceRef: expected object`);
        } else {
          rejectUnknownKeys(member.sourceRef, SOURCE_REF_KEYS, `${memberBase}.sourceRef`, errors);
        }
      }
      if (member.weight !== undefined && !(isRecord(member.sourceRef) && typeof member.sourceRef.system === 'string' && member.sourceRef.system.length > 0)) {
        errors.push(`${memberBase}.weight: numeric weight requires sourceRef.system`);
      }
    });
  });

  return errors;
}
