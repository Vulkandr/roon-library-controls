// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).
// Ported from arthursoares/roon-api-reverse-engineering (MIT), see NOTICE.

/**
 * The object graph: everything the Core pushes to us over the session.
 *
 * The Core first declares its types (DEFTYPE: type id, name, ordered members
 * with a PropertyType each), then pushes objects (PUSHOBJ / UPDATEOBJ: object
 * id, type id, then the fields). Because each member's PropertyType is known
 * from the DEFTYPE, every object can be read generically.
 *
 * Fields are sparse: `flexInt(memberIndex, 1-based) value` repeated, then a 0.
 * Members left out are at their default (0, false, null), so "missing" means
 * "default", not "unknown".
 *
 * Object-typed members are a flexLong: 0 = null, 1 = an inline value struct
 * (type id, length, sparse fields) follows, anything else = the id of another
 * object in the graph ({ $ref }).
 *
 * DataList<T> objects (the Core's lists) declare no members. Their body is
 * `flexInt(count)` followed by `count` object ids. (The upstream project read
 * these as sparse fields, which is why its lists came out empty.)
 *
 * Object ids are handles that only mean something in this session.
 */
import { Frame, Push } from './frame';
import { BinaryReader } from './wire';

export enum PropertyType {
  Int,
  Long,
  Bool,
  Guid,
  Sooid,
  Double,
  Float,
  Char,
  DateTime,
  Enum,
  NullableInt,
  NullableLong,
  NullableBool,
  NullableGuid,
  NullableSooid,
  NullableDouble,
  NullableFloat,
  NullableChar,
  NullableDateTime,
  NullableEnum,
  String,
  ByteArray,
  Message,
  Object,
  LengthPrefixed,
}

export interface TypeMember {
  name: string;
  propType: PropertyType;
}

export interface TypeDef {
  id: number;
  name: string;
  members: TypeMember[];
}

/** A reference to another object in the graph. */
export interface ObjRef {
  $ref: bigint;
}

export function isRef(v: unknown): v is ObjRef {
  return typeof v === 'object' && v !== null && '$ref' in (v as object);
}

/** An inline value struct that came back by value (not in the graph). */
export interface InlineStruct {
  $type: string;
  [member: string]: unknown;
}

export interface RoonObject {
  oid: bigint;
  typeId: number;
  /** Fully qualified, e.g. "Sooloos.Broker.Api.TrackLite". */
  typeName: string;
  /** Keyed by the full member name the Core uses, e.g. "string Sooloos.Broker.Api.TrackLite::Title". */
  fields: Record<string, unknown>;
  /** DataList<T> only: the ids of the items (by-reference items). */
  items?: bigint[];
  /** DataList<T> only: items sent by value (inline structs), in list order. */
  structs?: InlineStruct[];
}

const DATA_LIST = /(^|\.)DataList</;

export class ObjectGraph {
  readonly types = new Map<number, TypeDef>();
  readonly objects = new Map<bigint, RoonObject>();

  /**
   * Called after every object push or update, with the names of the fields
   * that push carried (UPDATEOBJ sends only what changed).
   */
  onObject: (obj: RoonObject, pushedFields: string[]) => void = () => {};

  /** Feeds one inbound push frame. Returns true if it was a type or object frame. */
  ingest(frame: Frame): boolean {
    if (frame.isResponse) return false;
    const r = new BinaryReader(frame.body);
    try {
      switch (frame.cmd) {
        case Push.DEFTYPE:
          this.defineType(r);
          return true;
        case Push.PUSHOBJ:
          this.pushObject(r, true);
          return true;
        case Push.PUSHSTUB:
          this.pushObject(r, false);
          return true;
        case Push.UPDATEOBJ:
          this.pushObject(r, true);
          return true;
        default:
          return false;
      }
    } catch {
      // A frame we couldn't read completely is skipped rather than fatal.
      return false;
    }
  }

  private defineType(r: BinaryReader): void {
    const id = r.flexInt();
    const name = r.string() ?? '';
    const count = r.flexInt();
    const members: TypeMember[] = [];
    for (let i = 0; i < count; i++) {
      const memberName = r.string() ?? '';
      const propType = r.integer() as PropertyType;
      members.push({ name: memberName, propType });
    }
    this.types.set(id, { id, name, members });
  }

  private pushObject(r: BinaryReader, populate: boolean): void {
    const oid = r.flexLong();
    const typeId = r.flexInt();
    const def = this.types.get(typeId);
    const typeName = def?.name ?? `#${typeId}`;
    const fields: Record<string, unknown> = {};
    let items: bigint[] | undefined;
    let structs: InlineStruct[] | undefined;

    if (populate && def) {
      if (DATA_LIST.test(typeName)) {
        // Each item is an Object: a reference, or a struct by value (see readValue).
        const count = r.flexInt();
        items = [];
        structs = [];
        for (let i = 0; i < count && r.remaining > 0; i++) {
          const v = this.readValue(r, PropertyType.Object);
          if (v && (v as ObjRef).$ref !== undefined) items.push((v as ObjRef).$ref);
          else if (v && (v as InlineStruct).$type !== undefined) structs.push(v as InlineStruct);
        }
      } else {
        this.readSparseFields(r, def, fields);
      }
    }

    const existing = this.objects.get(oid);
    let obj: RoonObject;
    if (existing && populate) {
      Object.assign(existing.fields, fields);
      if (items) existing.items = items;
      if (structs) existing.structs = structs;
      obj = existing;
    } else if (existing) {
      obj = existing;
    } else {
      obj = { oid, typeId, typeName, fields, items, structs };
      this.objects.set(oid, obj);
    }
    this.onObject(obj, Object.keys(fields));
  }

  private readSparseFields(r: BinaryReader, def: TypeDef, into: Record<string, unknown>): void {
    for (;;) {
      const idx = r.flexInt();
      if (idx === 0) break;
      const member = def.members[idx - 1];
      if (!member) break; // an index we don't know: we can't tell how long the value is
      into[member.name] = this.readValue(r, member.propType);
    }
  }

  /** Reads one value according to its PropertyType. */
  readValue(r: BinaryReader, t: PropertyType): unknown {
    switch (t) {
      case PropertyType.Int:
        return r.integer();
      case PropertyType.Long:
        return r.long();
      case PropertyType.Bool:
        return r.boolean();
      case PropertyType.Guid:
        return r.guid();
      case PropertyType.Sooid:
        return r.sooid();
      case PropertyType.Double:
        return r.double();
      case PropertyType.Float:
        return r.float();
      case PropertyType.Char:
        return r.char();
      case PropertyType.DateTime:
        return r.dateTime();
      case PropertyType.Enum:
        return r.integer();
      case PropertyType.NullableInt:
        return r.optionalInteger();
      case PropertyType.NullableLong:
        return r.optionalLong();
      case PropertyType.NullableBool:
        return r.optionalBoolean();
      case PropertyType.NullableGuid:
        return r.optionalGuid();
      case PropertyType.NullableSooid:
        return r.optionalSooid();
      case PropertyType.NullableDouble:
        return r.optionalDouble();
      case PropertyType.NullableFloat:
        return r.optionalFloat();
      case PropertyType.NullableChar:
        return r.optionalChar();
      case PropertyType.NullableDateTime:
        return r.optionalDateTime();
      case PropertyType.NullableEnum:
        return r.optionalInteger();
      case PropertyType.String:
        return r.string();
      case PropertyType.ByteArray:
        return r.byteArray();
      case PropertyType.Message:
        return r.byteArray();
      case PropertyType.Object: {
        const marker = r.long();
        if (marker === 0n) return null;
        if (marker !== 1n) return { $ref: marker } as ObjRef;
        // Inline value struct: type id, byte length, sparse fields.
        const typeId = r.integer();
        const len = r.integer();
        const sub = new BinaryReader(r.bytes(len));
        const def = this.types.get(typeId);
        if (!def) return { $type: `#${typeId}` } as InlineStruct;
        const obj: InlineStruct = { $type: def.name };
        try {
          this.readSparseFields(sub, def, obj);
        } catch {
          // keep what was read
        }
        return obj;
      }
      case PropertyType.LengthPrefixed:
        return r.bytes(r.integer());
      default:
        throw new Error(`unknown PropertyType ${t}`);
    }
  }

  /**
   * Decodes a method's return value (the bytes after the status string) that
   * used the Object encoding, e.g. an inline struct returned by value.
   */
  decodeReturnValue(payload: Uint8Array): unknown {
    return this.readValue(new BinaryReader(payload), PropertyType.Object);
  }

  /**
   * Decodes a returned list (`ResultCallback<IList<T>>`): flexInt(byte length),
   * flexInt(count), then `count` Object-encoded values.
   */
  decodeReturnList(payload: Uint8Array): unknown[] {
    const r = new BinaryReader(payload);
    r.flexInt(); // byte length of the rest
    const count = r.flexInt();
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) out.push(this.readValue(r, PropertyType.Object));
    return out;
  }

  getObject(oid: bigint | number): RoonObject | undefined {
    return this.objects.get(BigInt(oid));
  }

  /** Objects whose type name is, or ends with ".", the given name. */
  findByType(name: string): RoonObject[] {
    const suffix = name.includes('.') ? name : `.${name}`;
    const out: RoonObject[] = [];
    for (const o of this.objects.values()) {
      if (o.typeName === name || o.typeName.endsWith(suffix)) out.push(o);
    }
    return out;
  }

  /** The object a field points at, if it is a reference to one in the graph. */
  deref(value: unknown): RoonObject | undefined {
    return isRef(value) ? this.objects.get(value.$ref) : undefined;
  }
}

/** A field by the end of its name ("::Title"), since names are fully qualified. */
export function field<T = unknown>(obj: RoonObject | InlineStruct | undefined, suffix: string): T | undefined {
  if (!obj) return undefined;
  const source = 'fields' in obj && obj.fields ? (obj as RoonObject).fields : (obj as InlineStruct);
  const wanted = `::${suffix}`;
  for (const [k, v] of Object.entries(source)) {
    if (k.endsWith(wanted)) return v as T;
  }
  return undefined;
}

/** The exact member name (as the Core spells it) for a field suffix. */
export function fieldName(obj: RoonObject | InlineStruct | undefined, suffix: string): string | undefined {
  if (!obj) return undefined;
  const source = 'fields' in obj && obj.fields ? (obj as RoonObject).fields : (obj as InlineStruct);
  const wanted = `::${suffix}`;
  return Object.keys(source).find((k) => k.endsWith(wanted));
}
