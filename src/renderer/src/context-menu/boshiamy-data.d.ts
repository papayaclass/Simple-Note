// Loose type for the large generated data module so tsc does not deeply type
// the ~20k-entry literal. Runtime value comes from boshiamy-data.js.
declare const data: Record<string, Record<string, number>>;
export default data;
