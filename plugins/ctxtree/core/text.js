// Small text helpers with the same output in Node and in the mod runtime
// (which may lack locale data, so no toLocaleString).
export const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
