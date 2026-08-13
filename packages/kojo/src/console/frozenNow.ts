/**
 * The instant every Console fixture is written against — 2026-03-01T12:00:00Z.
 *
 * It has a module of its own, and the module imports nothing. The fixtures need it, and so does the
 * browser tier, which runs in a plain Node process under Playwright and must not have to load Effect
 * to learn one number. A constant two places agree on by accident is a constant that drifts.
 */
export const frozenNow = 1_772_366_400_000;
