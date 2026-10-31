import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { EmptyState } from "./States";

export type Column<T> = {
  id: string;
  header: string;
  cell: (row: T) => ComponentChildren;
  align?: "end";
  /** Monospace for identifiers and codes. */
  mono?: boolean;
  nowrap?: boolean;
};

type TableProps<T> = {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: string;
  emptyDetail?: ComponentChildren;
  /** Show the caption instead of keeping it for assistive technology only. */
  showCaption?: boolean;
  maxHeight?: boolean;
};

export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty = "Nothing to show",
  emptyDetail,
  showCaption,
  maxHeight,
}: TableProps<T>) {
  const id = useId();
  if (rows.length === 0) return <EmptyState title={empty}>{emptyDetail}</EmptyState>;
  return (
    <>
      {/* Focusable so keyboard users can scroll a wide table without a mouse. */}
      {/* biome-ignore lint/a11y/useSemanticElements: labelled scroll region around a table */}
      <div
        class={`table-scroll${maxHeight ? " table-scroll-tall" : ""}`}
        role="region"
        aria-labelledby={id}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-scrollable region
        tabIndex={0}
      >
        <table class="table">
          <caption id={id} class={showCaption ? "table-caption" : "sr-only"}>
            {caption}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.id} scope="col" class={column.align === "end" ? "num" : undefined}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={rowKey(row, index)}>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    class={
                      [
                        column.align === "end" ? "num" : "",
                        column.mono ? "mono" : "",
                        column.nowrap ? "nowrap" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
