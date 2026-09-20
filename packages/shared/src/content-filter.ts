/**
 * Sexual-content filter for card text.
 *
 * This game is for a workplace happy hour, where "a party game for horrible
 * people" humour lands differently than it does among friends. Profanity is
 * deliberately allowed — swearing is fine. Sex and pornography are not.
 *
 * The importer applies this when generating deck JSON, and a test asserts no
 * shipped card matches it, so the rule is enforced rather than remembered.
 *
 * Every term is word-bounded, which matters enormously in a technical deck:
 * unanchored, `anal` matches "root cause analysis", `cum` matches "document"
 * and "accumulate", and `sex` matches "sexism". A test covers those exact
 * cases, because an over-eager filter here would quietly gut the deck.
 */
const TERMS = [
  'porn\\w*', 'sex', 'sexy', 'sexual\\w*', 'sexting', 'arous\\w*', 'erotic\\w*',
  'dick', 'dicks', 'cock', 'cocks', 'penis\\w*', 'vagina\\w*', 'pussy',
  'genitals?', 'masturbat\\w*', 'orgasm\\w*', 'cum', 'cumming', 'jizz',
  'blowjobs?', 'handjobs?', 'anal', 'boobs?', 'tits', 'nipples?',
  'erections?', 'horny', 'fetish\\w*', 'kinky', 'bdsm', 'dildos?',
  'nude', 'nudes', 'naked', 'topless', 'strippers?', 'brothels?',
  'prostitut\\w*', 'hookers?', 'threesomes?', 'orgy', 'orgies',
  'ejaculat\\w*', 'semen', 'testicles?', 'scrotum', 'clitoris',
  'foreplay', 'intercourse', 'fornicat\\w*', 'sodom\\w*', 'incest\\w*',
  'bestiality', 'molest\\w*', 'rape', 'raping', 'rapist', 'foreskin',
  'buttplug', 'fisting', 'bukkake', 'onlyfans', 'hentai', 'milf',
  'lingerie', 'seduc\\w*', 'sensual',
];

/**
 * Terms matched anywhere inside a word, not just at its edges.
 *
 * Word boundaries are the right default, but they miss compounds: `\bporn`
 * does not match "Youporn", which is exactly how one card slipped through the
 * first version of this filter. These specific strings appear in no ordinary
 * English word, so matching them as substrings is safe where doing the same
 * with `anal` or `cum` would be catastrophic.
 */
const SUBSTRING_TERMS = [
  'porn', 'xvideos', 'xhamster', 'redtube', 'brazzers', 'onlyfans',
  'camgirl', 'camwhore', 'nsfw',
];

/** Fresh instances per call: a shared /g regex would carry lastIndex between uses. */
export function sexualContentPattern(): RegExp {
  return new RegExp('\\b(' + TERMS.join('|') + ')\\b', 'i');
}

function substringPattern(): RegExp {
  return new RegExp('\\w*(' + SUBSTRING_TERMS.join('|') + ')\\w*', 'i');
}

/** The matched term if the text should be filtered, or null to keep it. */
export function blockedTerm(text: string): string | null {
  const bounded = sexualContentPattern().exec(text);
  if (bounded) return bounded[0];
  const embedded = substringPattern().exec(text);
  return embedded ? embedded[0] : null;
}
