/**
 * Archive writer abstraction. Phase 3A P4: CSV.GZ via Postgres COPY restored every tested column type
 * exactly and was fastest; typical JS Parquet/XLSX mappings lost data. CSV.GZ is the default; other
 * formats must implement the same round-trip contract (copyOut + copyIn restore exactly).
 */
export interface ArchiveFormat {
  id: "csv.gz";
  extension: string;
  /** COPY ... TO STDOUT options producing the uncompressed stream. */
  copyOutOptions: string;
  /** COPY ... FROM STDIN options that restore the same stream exactly. */
  copyInOptions: string;
  compressed: "gzip";
}

export const CSV_GZ: ArchiveFormat = {
  id: "csv.gz",
  extension: ".csv.gz",
  copyOutOptions: "FORMAT csv, HEADER",
  copyInOptions: "FORMAT csv, HEADER",
  compressed: "gzip",
};

export function formatById(id: string): ArchiveFormat {
  if (id === "csv.gz") return CSV_GZ;
  throw new Error(`unsupported archive format ${id}`);
}
