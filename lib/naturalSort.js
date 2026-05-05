// Natural sort helper: "10.png" sorts after "2.png", not before. Built on
// Intl.Collator(numeric: true) so it works for unicode filenames too.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalCompare(a, b) {
  return collator.compare(a, b);
}

export function naturalSort(values, getKey = (v) => v) {
  return [...values].sort((a, b) => naturalCompare(getKey(a), getKey(b)));
}
