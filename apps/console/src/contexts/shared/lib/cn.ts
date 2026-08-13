import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * One class list from many, with the later Tailwind utility winning.
 *
 * Zaidan's components are copied into the project rather than installed, and every one of them takes
 * a `class` prop that has to be able to override what the component sets. Plain concatenation cannot
 * do that — `px-4` and `px-2` would both survive and the cascade would pick by source order — so the
 * merge is what makes the prop mean anything.
 */
export const cn = (...inputs: ReadonlyArray<ClassValue>): string => twMerge(clsx(inputs));
