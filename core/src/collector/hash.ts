/**
 * FNV-1a 32-bit content hash — the collector's stable raw_ref ingredient for
 * sources whose records carry no native id (history.jsonl lines, OTel log
 * records). Deterministic across restarts so re-ingesting the same record
 * always lands on the same (backend, raw_ref) dedupe key.
 */

export function fnv32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps everything in uint32).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
