/** Quotes `word` for `sh`, so that it is one word whatever it holds. */
export const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`
