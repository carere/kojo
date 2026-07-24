import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackRouter({ target: "solid", autoCodeSplitting: true, enableRouteTreeFormatting: true }),
    solid(),
  ],
});
