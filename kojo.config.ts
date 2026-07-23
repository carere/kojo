import { defineConfig } from "./packages/workflow/src/index.ts";
import { Hello } from "./workflows/hello.ts";

export default defineConfig({ workflows: [Hello] });
