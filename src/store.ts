import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Store<T> = { read(): T; write(value: T): void; persisted: boolean };

// A JSON file per collection, written atomically. Without a directory, state lives in memory and says so.
export function jsonStore<T>(dir: string | undefined, name: string, initial: T): Store<T> {
  if (!dir) {
    let value = initial;
    return { read: () => value, write: (v) => void (value = v), persisted: false };
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  return {
    read: () => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
      } catch {
        return initial;
      }
    },
    write: (value) => {
      writeFileSync(`${file}.new`, JSON.stringify(value, null, 2));
      renameSync(`${file}.new`, file);
    },
    persisted: true,
  };
}
