import { MAX_PREVIEW_GRAPHEMES, graphemeCount } from './graphemes';

/** Whether inserting `data` at the selection stays within the grapheme limit. */
export function insertionFits(
  value: string,
  start: number,
  end: number,
  data: string,
  limit: number = MAX_PREVIEW_GRAPHEMES,
): boolean {
  // Count the resulting string: combining marks / matras can merge into an existing cluster,
  // and a letter between ZWJ parts can split one cluster into three.
  return graphemeCount(value.slice(0, start) + data + value.slice(end)) <= limit;
}

/** Input types that add text and must be gated before they land. */
export function isInsertInputType(inputType: string): boolean {
  return (
    inputType === 'insertText' ||
    inputType === 'insertFromPaste' ||
    inputType === 'insertFromDrop' ||
    inputType === 'insertFromYank' ||
    inputType === 'insertReplacementText' ||
    inputType === 'insertTranspose' ||
    inputType === 'insertFromPasteAsQuotation'
  );
}
