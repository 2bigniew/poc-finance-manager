declare module 'pg-cursor' {
  class Cursor<T = unknown> {
    constructor(sql: string, parameters?: unknown[]);
    read(rowsCount: number): Promise<T[]>;
    close(): Promise<void>;
  }

  export = Cursor;
}
