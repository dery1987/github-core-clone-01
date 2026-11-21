// git.ts — Git core + smart HTTP for the forge.
//
// Pure Node stdlib only (node:crypto, node:zlib, node:http). No git binary
// is used or required at runtime. Implements, from the git protocol specs:
//
//   * git objects (blob / tree / commit / tag) with SHA-1 ids
//   * packfile v2 encode + decode (full objects, OFS_DELTA, REF_DELTA,
//     thin packs against objects already on the server)
//   * pkt-line framing, flush / delim / response-end packets, side-band
//   * smart HTTP: info/refs advertisement (protocol v2 for upload-pack,
//     v0 for receive-pack), git-upload-pack (v0 and v2: ls-refs + fetch,
//     want/have negotiation, shallow / deepen), git-receive-pack
//     (unpack, ref updates, status report)
//
// State model: git data lives in a module-local Map in this file
// (key "owner/repo"), NOT in store.ts — store.ts is shared with the
// REST/GraphQL/MCP builders and its shape is theirs to own. The only
// coupling is that creating a git repo also registers { owner, name } in
// store.repos, so the REST side sees the repo. Refs and objects are
// content-addressed and contain no timestamps, so nothing here leaks
// wall-clock time into any state export.
//
// Determinism: pack object order is sorted by SHA-1; zlib deflate output
// is deterministic for a given input and Node version.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "./store.ts";

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const HEAD_REF = "refs/heads/main";
export const AGENT = "forge/0.1.0";

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export type ObjectType = "commit" | "tree" | "blob" | "tag";

const TYPE_CODES: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const CODE_TYPES: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

export function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** SHA-1 id of a git object: sha1("<type> <len>\0" + content). */
export function hashObject(type: ObjectType, content: Buffer): string {
  return sha1Hex(rawObject(type, content));
}

/** Raw stored form of an object: "<type> <len>\0" + content. */
export function rawObject(type: ObjectType, content: Buffer): Buffer {
  const header = Buffer.from(`${type} ${content.length}\0`, "ascii");
  return Buffer.concat([header, content]);
}

export function parseRawObject(raw: Buffer): { type: ObjectType; content: Buffer } {
  const nul = raw.indexOf(0);
  if (nul === -1) throw new Error("object has no header terminator");
  const header = raw.subarray(0, nul).toString("ascii");
  const sp = header.indexOf(" ");
  const type = header.slice(0, sp) as ObjectType;
  const len = Number(header.slice(sp + 1));
  const content = raw.subarray(nul + 1);
  if (content.length !== len) {
    throw new Error(`object length mismatch: header ${len} vs ${content.length}`);
  }
  if (!TYPE_CODES[type]) throw new Error(`unknown object type ${type}`);
  return { type, content };
}

// ---------------------------------------------------------------------------
// Repo model (module-local Map; see header note)
// ---------------------------------------------------------------------------

export interface GitRepo {
  owner: string;
  name: string;
  /** sha-1 hex -> raw object bytes ("<type> <len>\0" + content). */
  objects: Map<string, Buffer>;
  /** refname (e.g. refs/heads/main) -> sha-1 hex. */
  refs: Map<string, string>;
}

const gitRepos = new Map<string, GitRepo>();

export function gitRepoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getGitRepo(owner: string, name: string): GitRepo | undefined {
  return gitRepos.get(gitRepoKey(owner, name));
}

export function getOrCreateGitRepo(owner: string, name: string): GitRepo {
  const key = gitRepoKey(owner, name);
  let repo = gitRepos.get(key);
  if (!repo) {
    repo = { owner, name, objects: new Map(), refs: new Map() };
    gitRepos.set(key, repo);
    // Register in the shared store so the REST side sees the repo.
    if (!store.repos.has(key)) store.repos.set(key, { owner, name });
  }
  return repo;
}

export function listGitRepos(): GitRepo[] {
  return [...gitRepos.values()];
}

/** Test/support helper: drop all git state. */
export function resetGitState(): void {
  gitRepos.clear();
}

export function putObject(repo: GitRepo, type: ObjectType, content: Buffer): string {
  const raw = rawObject(type, content);
  const sha = sha1Hex(raw);
  repo.objects.set(sha, raw);
  return sha;
}

export function getObject(
  repo: GitRepo,
  sha: string,
): { type: ObjectType; content: Buffer } | null {
  const raw = repo.objects.get(sha);
  return raw ? parseRawObject(raw) : null;
}

// ---------------------------------------------------------------------------
// Commit / tree / tag parsing and building
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(content: Buffer): CommitInfo {
  const text = content.toString("utf8");
  const sep = text.indexOf("\n\n");
  const head = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? "" : text.slice(sep + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of a multi-line header (gpgsig)
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = value;
    else if (key === "committer") committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < content.length) {
    const sp = content.indexOf(0x20, off);
    if (sp === -1) throw new Error("malformed tree: no space after mode");
    const mode = content.subarray(off, sp).toString("ascii");
    const nul = content.indexOf(0, sp);
    if (nul === -1 || nul + 21 > content.length) {
      throw new Error("malformed tree: no NUL after name");
    }
    const name = content.subarray(sp + 1, nul).toString("utf8");
    const sha = content.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(content: Buffer): TagInfo {
  const text = content.toString("utf8");
  const sep = text.indexOf("\n\n");
  const head = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? "" : text.slice(sep + 2);
  let object = "";
  let type: ObjectType = "commit";
  let tag = "";
  let tagger = "";
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "object") object = value;
    else if (key === "type") type = value as ObjectType;
    else if (key === "tag") tag = value;
    else if (key === "tagger") tagger = value;
  }
  return { object, type, tag, tagger, message };
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}

export function buildCommit(c: {
  tree: string;
  parents?: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents ?? []) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(s, "utf8");
}

export function buildTag(t: {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  const s =
    `object ${t.object}\ntype ${t.type}\ntag ${t.tag}\n` +
    `tagger ${t.tagger}\n\n${t.message}`;
  return Buffer.from(s, "utf8");
}

// ---------------------------------------------------------------------------
// Refs / HEAD
// ---------------------------------------------------------------------------

export function listRefs(repo: GitRepo): Array<{ name: string; sha: string }> {
  return [...repo.refs.entries()]
    .map(([name, sha]) => ({ name, sha }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * HEAD resolution: refs/heads/main when it exists, else the first branch
 * (sorted) so a clone can always check something out, else unborn HEAD
 * pointing at refs/heads/main.
 */
export function resolveHead(repo: GitRepo): { target: string; sha: string | null } {
  if (repo.refs.has(HEAD_REF)) {
    return { target: HEAD_REF, sha: repo.refs.get(HEAD_REF) ?? null };
  }
  const branches = [...repo.refs.keys()]
    .filter((r) => r.startsWith("refs/heads/"))
    .sort();
  if (branches.length > 0) {
    return { target: branches[0], sha: repo.refs.get(branches[0]) ?? null };
  }
  return { target: HEAD_REF, sha: null };
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

function writeVarint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    if (i >= buf.length) throw new Error("truncated varint");
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: i };
}

/**
 * Encode a delta that reproduces `target` from `base` by inserting the
 * whole target (no copy ops). Simple, always valid, deterministic.
 */
export function encodeDelta(base: Buffer, target: Buffer): Buffer {
  const parts: Buffer[] = [writeVarint(base.length), writeVarint(target.length)];
  let off = 0;
  while (off < target.length) {
    const chunk = Math.min(127, target.length - off);
    parts.push(Buffer.from([chunk])); // insert op: length in low 7 bits
    parts.push(target.subarray(off, off + chunk));
    off += chunk;
  }
  return Buffer.concat(parts);
}

/** Apply a git delta to `base`, verifying source and target sizes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readVarint(delta, 0);
  if (src.value !== base.length) {
    throw new Error(`delta base size mismatch: ${src.value} vs ${base.length}`);
  }
  const tgt = readVarint(delta, src.next);
  const out: Buffer[] = [];
  let off = tgt.next;
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      // copy from base: offset/size bytes selected by opcode bits
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff < 0 || cpOff + cpSize > base.length) {
        throw new Error("delta copy out of range");
      }
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      if (off + op > delta.length) throw new Error("delta insert out of range");
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error("delta opcode 0 is invalid");
    }
  }
  if (total !== tgt.value) {
    throw new Error(`delta target size mismatch: ${total} vs ${tgt.value}`);
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Packfile v2
// ---------------------------------------------------------------------------

function encodePackObjectHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    out.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  out.push(b);
  return Buffer.from(out);
}

function readPackObjectHeader(
  buf: Buffer,
  off: number,
): { type: number; size: number; next: number } {
  let b = buf[off++];
  const type = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    if (off >= buf.length) throw new Error("truncated pack object header");
    b = buf[off++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: off };
}

function encodeOfsDeltaOffset(offset: number): Buffer {
  const bytes: number[] = [offset & 0x7f];
  let o = offset;
  while ((o >>= 7) > 0) {
    o -= 1;
    bytes.unshift(0x80 | (o & 0x7f));
  }
  return Buffer.from(bytes);
}

function readOfsDeltaOffset(
  buf: Buffer,
  off: number,
): { offset: number; next: number } {
  let b = buf[off++];
  let offset = b & 0x7f;
  while (b & 0x80) {
    if (off >= buf.length) throw new Error("truncated ofs-delta offset");
    b = buf[off++];
    offset = ((offset + 1) << 7) | (b & 0x7f);
  }
  return { offset, next: off };
}

/**
 * Inflate exactly one zlib stream starting at `offset` and report how many
 * bytes it consumed. `inflateSync` ignores trailing bytes but throws on a
 * truncated stream, so "smallest succeeding end" (binary search) is the
 * exact stream end.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  let lo = offset + 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, lo));
  return { data, consumed: lo - offset };
}

export interface PackEntry {
  sha: string;
  type: ObjectType;
  content: Buffer;
}

/**
 * Encode a packfile v2 from entries. Object order is sorted by SHA-1
 * (deterministic). With `deltas: true`, each object after the first of its
 * type is emitted as an OFS_DELTA against the most recently emitted object
 * of the same type (full-insert delta). With `deltas: false` (default)
 * every object is stored whole.
 */
export function encodePack(entries: PackEntry[], opts: { deltas?: boolean } = {}): Buffer {
  const sorted = [...entries].sort((a, b) => a.sha.localeCompare(b.sha));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  let pos = 12; // offset of the next object header
  const emitted: Array<{ sha: string; type: ObjectType; content: Buffer; offset: number }> = [];
  for (const e of sorted) {
    let objHeader: Buffer;
    let payload: Buffer;
    let base: (typeof emitted)[number] | undefined;
    if (opts.deltas) {
      for (let i = emitted.length - 1; i >= 0; i--) {
        if (emitted[i].type === e.type) {
          base = emitted[i];
          break;
        }
      }
    }
    if (base) {
      const delta = encodeDelta(base.content, e.content);
      objHeader = Buffer.concat([
        encodePackObjectHeader(6, delta.length),
        encodeOfsDeltaOffset(pos - base.offset),
      ]);
      payload = deflateSync(delta);
    } else {
      objHeader = encodePackObjectHeader(TYPE_CODES[e.type], e.content.length);
      payload = deflateSync(e.content);
    }
    parts.push(objHeader, payload);
    emitted.push({ sha: e.sha, type: e.type, content: e.content, offset: pos });
    pos += objHeader.length + payload.length;
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash("sha1").update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

export interface DecodedPack {
  /** sha-1 hex -> raw object bytes. */
  objects: Map<string, Buffer>;
  /** shas in pack order. */
  order: string[];
}

/**
 * Decode a packfile v2 (accepts version 3 header too). Verifies the SHA-1
 * trailer. OFS_DELTA bases must appear earlier in the same pack;
 * REF_DELTA bases may come from the same pack or from `baseObjects`
 * (thin-pack support: pass the server's object map).
 */
export function decodePack(buf: Buffer, baseObjects?: Map<string, Buffer>): DecodedPack {
  if (buf.length < 32) throw new Error("pack too short");
  if (buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("bad pack magic");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported pack version ${version}`);
  }
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash("sha1").update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error("pack checksum mismatch");

  const objects = new Map<string, Buffer>();
  const order: string[] = [];
  const byOffset = new Map<number, { sha: string; raw: Buffer }>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const objStart = off;
    const h = readPackObjectHeader(buf, off);
    off = h.next;
    let type: ObjectType;
    let content: Buffer;
    if (h.type === 6) {
      // OFS_DELTA
      const o = readOfsDeltaOffset(buf, off);
      off = o.next;
      const baseEntry = byOffset.get(objStart - o.offset);
      if (!baseEntry) throw new Error("ofs-delta base not found in pack");
      const base = parseRawObject(baseEntry.raw);
      const inf = inflateAt(buf, off);
      off += inf.consumed;
      if (inf.data.length !== h.size) throw new Error("delta size mismatch");
      content = applyDelta(base.content, inf.data);
      type = base.type;
    } else if (h.type === 7) {
      // REF_DELTA
      if (off + 20 > buf.length) throw new Error("truncated ref-delta base");
      const baseSha = buf.subarray(off, off + 20).toString("hex");
      off += 20;
      const inf = inflateAt(buf, off);
      off += inf.consumed;
      if (inf.data.length !== h.size) throw new Error("delta size mismatch");
      const baseRaw = objects.get(baseSha) ?? baseObjects?.get(baseSha);
      if (!baseRaw) {
        throw new Error(`ref-delta base ${baseSha} not available (thin pack base missing)`);
      }
      const base = parseRawObject(baseRaw);
      content = applyDelta(base.content, inf.data);
      type = base.type;
    } else {
      type = CODE_TYPES[h.type];
      if (!type) throw new Error(`unknown pack object type ${h.type}`);
      const inf = inflateAt(buf, off);
      off += inf.consumed;
      if (inf.data.length !== h.size) {
        throw new Error(`object size mismatch: got ${inf.data.length}, want ${h.size}`);
      }
      content = inf.data;
    }
    const raw = rawObject(type, content);
    const sha = sha1Hex(raw);
    objects.set(sha, raw);
    order.push(sha);
    byOffset.set(objStart, { sha, raw });
  }
  return { objects, order };
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const len = payload.length + 4;
  if (len > 65520) throw new Error("pkt-line too large");
  const head = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, payload]);
}

export const flushPkt = (): Buffer => Buffer.from("0000", "ascii");
export const delimPkt = (): Buffer => Buffer.from("0001", "ascii");
export const responseEndPkt = (): Buffer => Buffer.from("0002", "ascii");

export type PktLine =
  | { kind: "data"; data: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "response-end" };

/**
 * Parse pkt-lines from `buf` starting at `start`. Stops at the first flush
 * packet (or end of buffer) and reports how many bytes were consumed, so
 * the caller can find a raw packfile that follows the flush.
 */
export function parsePktLines(buf: Buffer, start = 0): { lines: PktLine[]; consumed: number } {
  const lines: PktLine[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString("ascii"), 16);
    if (Number.isNaN(len)) throw new Error(`invalid pkt-line length at offset ${off}`);
    if (len === 0) {
      lines.push({ kind: "flush" });
      off += 4;
      break;
    }
    if (len === 1) {
      lines.push({ kind: "delim" });
      off += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: "response-end" });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error("truncated pkt-line");
    lines.push({ kind: "data", data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { lines, consumed: off - start };
}

/**
 * Wrap `data` in side-band packets on `channel` (1 = pack data,
 * 2 = progress, 3 = error). Max chunk keeps each pkt-line <= 65520 bytes
 * (side-band-64k) or <= 1000 bytes (legacy side-band).
 */
export function sidebandPackets(
  channel: 1 | 2 | 3,
  data: Buffer,
  maxChunk = 65515,
): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += maxChunk) {
    const chunk = data.subarray(off, off + maxChunk);
    out.push(pktLine(Buffer.concat([Buffer.from([channel]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reachability walk
// ---------------------------------------------------------------------------

export interface ReachResult {
  objects: Set<string>;
  /**
   * Commits INCLUDED in the pack whose parents were cut off by a depth
   * limit — i.e. the deepest included commits that still have parents.
   * Real git lists these (not the cut-off parents) in `shallow` lines:
   * with deepen 1 the tip commit itself is shallow.
   */
  boundary: Set<string>;
}

/**
 * Collect all objects reachable from `tips`, not traversing into
 * `stopAt` (objects the client already has) or past `maxDepth`
 * (commit depth; tip = 0, so deepen N means maxDepth N-1).
 */
export function collectReachable(
  repo: GitRepo,
  tips: string[],
  stopAt: Set<string>,
  maxDepth?: number,
): ReachResult {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ sha: string; depth: number }> = tips.map((sha) => ({
    sha,
    depth: 0,
  }));
  while (queue.length > 0) {
    const { sha, depth } = queue.shift() as { sha: string; depth: number };
    if (seen.has(sha) || stopAt.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (!obj) continue; // unknown object: skip (wants are validated by caller)
    objects.add(sha);
    if (obj.type === "commit") {
      const c = parseCommit(obj.content);
      if (!seen.has(c.tree) && !stopAt.has(c.tree)) {
        queue.push({ sha: c.tree, depth });
      }
      for (const p of c.parents) {
        if (maxDepth !== undefined && depth + 1 > maxDepth) {
          // Depth cut: this commit (not the parent) is the shallow
          // boundary — its parents are missing from the pack.
          if (c.parents.length > 0) boundary.add(sha);
          continue;
        }
        queue.push({ sha: p, depth: depth + 1 });
      }
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.content)) {
        if (!seen.has(e.sha) && !stopAt.has(e.sha)) queue.push({ sha: e.sha, depth });
      }
    } else if (obj.type === "tag") {
      const t = parseTag(obj.content);
      if (!seen.has(t.object) && !stopAt.has(t.object)) {
        queue.push({ sha: t.object, depth });
      }
    }
  }
  return { objects, boundary };
}

// ---------------------------------------------------------------------------
// Smart HTTP: responses
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const UPLOAD_PACK_CAPS =
  `multi_ack multi_ack_detailed thin-pack side-band-64k side-band ` +
  `ofs-delta shallow no-done no-progress include-tag agent=${AGENT}`;
const RECEIVE_PACK_CAPS =
  `report-status delete-refs side-band-64k quiet atomic ofs-delta ` +
  `agent=${AGENT}`;

function advertisementV0(repo: GitRepo, service: "git-upload-pack" | "git-receive-pack"): Buffer {
  const head = resolveHead(repo);
  const caps =
    (service === "git-upload-pack" ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS) +
    ` symref=HEAD:${head.target}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    // Real git advertises an empty repo as a zero-oid "capabilities^{}"
    // line (no HEAD line).
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head.sha ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const r of refs) parts.push(pktLine(`${r.sha} ${r.name}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Protocol v2 capability advertisement (upload-pack only). */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine("version 2\n"),
    pktLine(`agent=${AGENT}\n`),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow wait-for-done\n"),
    pktLine("server-option\n"),
    pktLine("object-format=sha1\n"),
    flushPkt(),
  ]);
}

export function infoRefsResponse(
  owner: string,
  repoName: string,
  service: "git-upload-pack" | "git-receive-pack",
  gitProtocol?: string,
): HttpResult {
  const repo = getOrCreateGitRepo(owner, repoName);
  // Real git only advertises protocol v2 when the client asked for it
  // with the `Git-Protocol: version=2` request header; otherwise it
  // advertises v0 (and clients happily use v0).
  if (service === "git-upload-pack" && gitProtocol === "version=2") {
    return {
      status: 200,
      headers: {
        "content-type": "application/x-git-upload-pack-advertisement",
        "cache-control": "no-cache",
      },
      body: advertisementV2(),
    };
  }
  if (service === "git-upload-pack") {
    return {
      status: 200,
      headers: {
        "content-type": "application/x-git-upload-pack-advertisement",
        "cache-control": "no-cache",
      },
      body: advertisementV0(repo, service),
    };
  }
  return {
    status: 200,
    headers: {
      "content-type": "application/x-git-receive-pack-advertisement",
      "cache-control": "no-cache",
    },
    body: advertisementV0(repo, service),
  };
}

// ---------------------------------------------------------------------------
// upload-pack request parsing (shared by v0 and v2 fetch)
// ---------------------------------------------------------------------------

interface UploadRequest {
  wants: string[];
  haves: string[];
  clientShallows: string[];
  deepen: number | null;
  deepenSince: string | null;
  deepenNot: string[];
  filter: string | null;
  includeTag: boolean;
  /** Whether the client sent a "done" line (v0 two-phase negotiation). */
  done: boolean;
  caps: Set<string>;
  sideband: "64k" | "side" | null;
  sidebandAll: boolean;
}

function parseCaps(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

function parseUploadLines(lines: string[], firstLineCaps: boolean): UploadRequest {
  const req: UploadRequest = {
    wants: [],
    haves: [],
    clientShallows: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    includeTag: false,
    done: false,
    caps: new Set(),
    sideband: null,
    sidebandAll: false,
  };
  let first = true;
  for (const raw of lines) {
    const text = raw.replace(/\n$/, "");
    if (text.startsWith("want ")) {
      const rest = text.slice(5);
      const sp = rest.indexOf(" ");
      const sha = sp === -1 ? rest : rest.slice(0, sp);
      req.wants.push(sha);
      if (first && firstLineCaps && sp !== -1) req.caps = parseCaps(rest.slice(sp + 1));
    } else if (text.startsWith("have ")) {
      req.haves.push(text.slice(5).trim());
    } else if (text.startsWith("shallow ")) {
      req.clientShallows.push(text.slice(8).trim());
    } else if (text.startsWith("deepen ")) {
      const n = parseInt(text.slice(7), 10);
      if (!Number.isNaN(n)) req.deepen = n;
    } else if (text.startsWith("deepen-since ")) {
      req.deepenSince = text.slice(13).trim();
    } else if (text.startsWith("deepen-not ")) {
      req.deepenNot.push(text.slice(11).trim());
    } else if (text.startsWith("filter ")) {
      req.filter = text.slice(7).trim();
    } else if (text === "include-tag") {
      req.includeTag = true;
    } else if (text === "done") {
      req.done = true;
    } else if (text === "sideband-all") {
      req.sidebandAll = true;
    }
    // "done" and anything unknown are ignored.
    first = false;
  }
  if (req.caps.has("side-band-64k")) req.sideband = "64k";
  else if (req.caps.has("side-band")) req.sideband = "side";
  if (req.sidebandAll) req.sideband = "64k";
  return req;
}

function parseUploadPackV0(body: Buffer): UploadRequest {
  // git sends wants/haves, a flush, then "done" and a final flush, all in
  // one POST body — parse every pkt-line in the body, not just up to the
  // first flush.
  const texts: string[] = [];
  let off = 0;
  while (off < body.length) {
    const { lines, consumed } = parsePktLines(body, off);
    if (consumed === 0) break;
    for (const l of lines) {
      if (l.kind === "data") texts.push(l.data.toString("utf8"));
    }
    off += consumed;
  }
  return parseUploadLines(texts, true);
}

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const { lines } = parsePktLines(body);
  const dataLines: string[] = [];
  let seenDelim = false;
  const args: string[] = [];
  for (const l of lines) {
    if (l.kind === "delim") {
      seenDelim = true;
      continue;
    }
    if (l.kind !== "data") continue;
    const text = l.data.toString("utf8").replace(/\n$/, "");
    if (!seenDelim) dataLines.push(text);
    else args.push(text);
  }
  const commandLine = dataLines[0] ?? "";
  const command = commandLine.startsWith("command=")
    ? commandLine.slice("command=".length)
    : "";
  return { command, args };
}

/** Shared core of the upload-pack answer: negotiation + pack. */
function buildPackAnswer(
  repo: GitRepo,
  req: UploadRequest,
): {
  pack: Buffer;
  shallowLines: string[];
  unshallowLines: string[];
  /** haves that are ancestors of (or equal to) a want — for v0 ACKs. */
  common: string[];
  /** haves the server has at all (request order) — for v2 ACKs. */
  ackedHaves: string[];
} {
  const stopAt = new Set(req.haves);
  // deepen-since / deepen-not / filter are not advertised, so a client
  // should not send them; if one does, treat as a plain deepen-1
  // request rather than failing the fetch.
  let maxDepth: number | undefined;
  if (req.deepen !== null) maxDepth = req.deepen - 1;
  else if (req.deepenSince !== null || req.deepenNot.length > 0) maxDepth = 0;
  const { objects, boundary } = collectReachable(repo, req.wants, stopAt, maxDepth);
  // v0 ACKs ("common"): haves reachable from the wants (ancestors).
  const allReachable = collectReachable(repo, req.wants, new Set(), undefined).objects;
  const common = req.haves.filter((h) => allReachable.has(h)).sort();
  // v2 ACKs: every have the server simply HAS (existence, request order)
  // — real git ACKs even a have on an unrelated branch, and omits the
  // whole section when none of the haves exist.
  const ackedHaves = req.haves.filter((h) => repo.objects.has(h));
  // include-tag (shallow clones ask for it): also send annotated tag
  // objects that point at commits in the pack.
  if (req.includeTag) {
    for (const [sha, raw] of repo.objects) {
      if (objects.has(sha)) continue;
      const parsed = parseRawObject(raw);
      if (parsed.type === "tag" && objects.has(parseTag(parsed.content).object)) {
        objects.add(sha);
      }
    }
  }
  // Shallow lines carry NO trailing newline (verified against real git
  // 2.43, both v0 and v2 shallow-info).
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  for (const b of [...boundary].sort()) shallowLines.push(`shallow ${b}`);
  for (const s of req.clientShallows) {
    const obj = getObject(repo, s);
    if (!obj || obj.type !== "commit") continue;
    const parents = parseCommit(obj.content).parents;
    if (parents.every((p) => objects.has(p))) {
      unshallowLines.push(`unshallow ${s}`);
    } else if (objects.has(s) && !shallowLines.includes(`shallow ${s}`)) {
      shallowLines.push(`shallow ${s}`);
    }
  }
  const entries: PackEntry[] = [...objects].sort().map((sha) => {
    const o = getObject(repo, sha) as { type: ObjectType; content: Buffer };
    return { sha, type: o.type, content: o.content };
  });
  // Full objects only: a self-contained pack always works for the client,
  // and avoids any risk from delta bugs on the hot path. Delta encoding
  // is exercised by encodePack({deltas:true}) + decodePack round-trips.
  const pack = encodePack(entries, { deltas: false });
  return { pack, shallowLines, unshallowLines, common, ackedHaves };
}

function buildUploadPackV0Response(repo: GitRepo, body: Buffer): Buffer {
  const req = parseUploadPackV0(body);
  for (const w of req.wants) {
    if (!repo.objects.has(w)) {
      return Buffer.concat([
        pktLine(`ERR upload-pack: not our ref ${w}\n`),
        flushPkt(),
      ]);
    }
  }
  const { pack, shallowLines, unshallowLines, common } = buildPackAnswer(repo, req);
  const parts: Buffer[] = [];
  if (!req.done) {
    // Two-phase v0 negotiation (shallow clone): the client first sends
    // want + deepen WITHOUT "done" and expects ONLY the shallow list +
    // flush back. It then repeats the request WITH "done" to get the
    // pack. Sending NAK + pack here makes the client fail with
    // "expected shallow list". Verified against real git 2.43.
    for (const s of shallowLines) parts.push(pktLine(s));
    for (const s of unshallowLines) parts.push(pktLine(s));
    parts.push(flushPkt());
    return Buffer.concat(parts);
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    // Real git terminates the shallow section with a flush before ACK/NAK.
    for (const s of shallowLines) parts.push(pktLine(s));
    for (const s of unshallowLines) parts.push(pktLine(s));
    parts.push(flushPkt());
  }
  // Negotiation result (multi_ack_detailed format, as real git sends it):
  // "ACK <sha> common" per common have + a final bare ACK, else NAK.
  if (common.length > 0 && req.caps.has("multi_ack_detailed")) {
    for (const c of common) parts.push(pktLine(`ACK ${c} common\n`));
    parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  } else if (common.length > 0 && req.caps.has("multi_ack")) {
    for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
  } else if (common.length > 0) {
    parts.push(pktLine(`ACK ${common[0]}\n`));
  } else {
    parts.push(pktLine("NAK\n"));
  }
  if (req.sideband) {
    parts.push(...sidebandPackets(1, pack, req.sideband === "64k" ? 65515 : 995));
    parts.push(flushPkt());
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

function handleLsRefs(repo: GitRepo, args: string[]): Buffer {
  let peel = false;
  let unborn = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === "peel") peel = true;
    else if (a === "unborn") unborn = true;
    else if (a === "symrefs") symrefs = true;
    else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice("ref-prefix ".length));
  }
  const head = resolveHead(repo);
  const match = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  // HEAD is always reported when it resolves, so clones find the default
  // branch even when the client only asked for refs/ prefixes.
  if (head.sha) {
    let line = `${head.sha} HEAD`;
    if (symrefs) line += ` symref-target:${head.target}`;
    parts.push(pktLine(line + "\n"));
  } else if (unborn) {
    // Real git reports an unborn HEAD with the literal word "unborn" as
    // the object id — NOT the zero oid. A zero-oid line is parsed by the
    // client as a real ref and it then tries to fetch it.
    let line = "unborn HEAD";
    if (symrefs) line += ` symref-target:${head.target}`;
    parts.push(pktLine(line + "\n"));
  }
  for (const r of listRefs(repo)) {
    if (!match(r.name)) continue;
    let line = `${r.sha} ${r.name}`;
    if (peel) {
      const obj = getObject(repo, r.sha);
      if (obj && obj.type === "tag") {
        // v2 reports the peeled target as an attribute on the tag line,
        // NOT as a separate "^{}" line.
        line += ` peeled:${parseTag(obj.content).object}`;
      }
    }
    parts.push(pktLine(line + "\n"));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function handleFetchV2(repo: GitRepo, args: string[]): Buffer {
  const req = parseUploadLines(args, false);
  for (const w of req.wants) {
    if (!repo.objects.has(w)) {
      return Buffer.concat([
        pktLine(`ERR upload-pack: not our ref ${w}\n`),
        flushPkt(),
      ]);
    }
  }
  const { pack, shallowLines, unshallowLines, ackedHaves } = buildPackAnswer(repo, req);
  const parts: Buffer[] = [];
  // Acknowledgment section (only when at least one have exists on the
  // server; omitted entirely otherwise — verified against real git):
  // "acknowledgments", ACK per have (request order), "ready", delim.
  if (ackedHaves.length > 0) {
    parts.push(pktLine("acknowledgments\n"));
    for (const h of ackedHaves) parts.push(pktLine(`ACK ${h}\n`));
    parts.push(pktLine("ready\n"));
    parts.push(delimPkt());
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    parts.push(pktLine("shallow-info\n"));
    for (const s of shallowLines) parts.push(pktLine(s));
    for (const s of unshallowLines) parts.push(pktLine(s));
    parts.push(delimPkt());
  }
  parts.push(pktLine("packfile\n"));
  // In protocol v2 the packfile is ALWAYS sent as side-band packets
  // (channel 1 = pack data), followed by a flush — verified against real
  // git 2.43 upload-pack. A raw pack here makes the client fail with
  // "bad line length character: PACK".
  parts.push(...sidebandPackets(1, pack));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

export function uploadPackResponse(owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = getOrCreateGitRepo(owner, repoName);
  const contentType = "application/x-git-upload-pack-result";
  try {
    const { lines } = parsePktLines(body);
    const first = lines[0];
    if (first && first.kind === "data") {
      const text = first.data.toString("utf8").replace(/\n$/, "");
      if (text.startsWith("command=")) {
        const { command, args } = parseV2Command(body);
        if (command === "ls-refs") {
          return { status: 200, headers: { "content-type": contentType }, body: handleLsRefs(repo, args) };
        }
        if (command === "fetch") {
          return { status: 200, headers: { "content-type": contentType }, body: handleFetchV2(repo, args) };
        }
        return {
          status: 400,
          headers: { "content-type": "text/plain" },
          body: Buffer.from(`unknown command ${command}`),
        };
      }
    }
    return {
      status: 200,
      headers: { "content-type": contentType },
      body: buildUploadPackV0Response(repo, body),
    };
  } catch (err) {
    return {
      status: 500,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`upload-pack error: ${(err as Error).message}`),
    };
  }
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export function receivePackResponse(owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = getOrCreateGitRepo(owner, repoName);
  const contentType = "application/x-git-receive-pack-result";
  try {
    const { lines, consumed } = parsePktLines(body);
    const updates: Array<{ oldSha: string; newSha: string; ref: string }> = [];
    let caps = new Set<string>();
    let first = true;
    for (const l of lines) {
      if (l.kind !== "data") continue;
      let text = l.data.toString("utf8");
      if (first) {
        const nul = text.indexOf("\0");
        if (nul !== -1) {
          caps = parseCaps(text.slice(nul + 1).trim());
          text = text.slice(0, nul);
        }
        first = false;
      }
      const m = text.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
      if (!m) continue;
      updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
    }
    const packBuf = body.subarray(consumed);
    if (packBuf.length > 0) {
      // Thin-pack aware: deltas may reference objects already on disk.
      const decoded = decodePack(packBuf, repo.objects);
      for (const [sha, raw] of decoded.objects) repo.objects.set(sha, raw);
    }
    const results: Array<{ ref: string; ok: boolean; msg?: string }> = [];
    for (const u of updates) {
      if (u.newSha === ZERO_OID) {
        repo.refs.delete(u.ref);
        results.push({ ref: u.ref, ok: true });
      } else if (!repo.objects.has(u.newSha)) {
        results.push({ ref: u.ref, ok: false, msg: "object not found" });
      } else {
        // Accept fast-forward and force updates alike (per spec for the
        // suite): a push succeeds unless its objects are corrupt.
        repo.refs.set(u.ref, u.newSha);
        results.push({ ref: u.ref, ok: true });
      }
    }
    if (!caps.has("report-status")) {
      return { status: 200, headers: { "content-type": contentType }, body: Buffer.alloc(0) };
    }
    const report: Buffer[] = [pktLine("unpack ok\n")];
    for (const r of results) {
      report.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.msg ?? "failed"}\n`));
    }
    let out: Buffer;
    if (caps.has("side-band-64k")) {
      // Real git sends the WHOLE report (pkt-lines AND the terminating
      // flush) inside side-band packets, then a bare outer flush. Sending
      // each line as its own side-band packet with no inner flush makes
      // the client hang waiting for the report terminator.
      const inner = Buffer.concat([...report, flushPkt()]);
      out = Buffer.concat([...sidebandPackets(1, inner), flushPkt()]);
    } else {
      out = Buffer.concat([...report, flushPkt()]);
    }
    return { status: 200, headers: { "content-type": contentType }, body: out };
  } catch (err) {
    return {
      status: 500,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`receive-pack error: ${(err as Error).message}`),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP wiring helper (router integration point)
// ---------------------------------------------------------------------------

/**
 * Handle a smart-HTTP git request. Returns true when the path matched a
 * git endpoint (and the response was written), false otherwise so the
 * caller can fall through to its own 404 / other routes.
 */
export async function gitHttpHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  let repoName = decodeURIComponent(m[2]);
  if (repoName.endsWith(".git")) repoName = repoName.slice(0, -4);
  const endpoint = m[3];

  if (req.method === "GET" && endpoint === "info/refs") {
    const service = url.searchParams.get("service") ?? "";
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("unknown service");
      return true;
    }
    const gp = req.headers["git-protocol"];
    const gitProtocol = Array.isArray(gp) ? gp[0] : gp;
    const r = infoRefsResponse(
      owner,
      repoName,
      service as "git-upload-pack" | "git-receive-pack",
      gitProtocol,
    );
    res.writeHead(r.status, { ...r.headers, "content-length": r.body.length });
    res.end(r.body);
    return true;
  }

  if (
    req.method === "POST" &&
    (endpoint === "git-upload-pack" || endpoint === "git-receive-pack")
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const r =
      endpoint === "git-upload-pack"
        ? uploadPackResponse(owner, repoName, body)
        : receivePackResponse(owner, repoName, body);
    res.writeHead(r.status, { ...r.headers, "content-length": r.body.length });
    res.end(r.body);
    return true;
  }
  return false;
}

/** Deterministic snapshot of git state (sorted keys, no timestamps). */
export function gitStateSnapshot(): string {
  const repos: Record<string, { refs: Record<string, string>; objects: string[] }> = {};
  for (const [key, repo] of [...gitRepos.entries()].sort()) {
    repos[key] = {
      refs: Object.fromEntries([...repo.refs.entries()].sort()),
      objects: [...repo.objects.keys()].sort(),
    };
  }
  return JSON.stringify({ repos }, null, 2);
}
