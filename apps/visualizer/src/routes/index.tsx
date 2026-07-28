import { createFileRoute } from "@tanstack/solid-router";
import type { PrototypeVariant } from "../contexts/workflow-execution/workflow-inspector/components/prototype/prototype-switcher";
import { WorkflowInspectorPrototype } from "../contexts/workflow-execution/workflow-inspector/components/prototype/workflow-inspector-prototype";

export const Route = createFileRoute("/")({
  validateSearch: (search): { prototype: boolean; variant: PrototypeVariant } => ({
    prototype: search.prototype === true || search.prototype === "true",
    variant: search.variant === "B" || search.variant === "C" ? search.variant : "A",
  }),
  component: WorkflowInspectorRoute,
});

function WorkflowInspectorRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <WorkflowInspectorPrototype
      showSwitcher={search().prototype}
      variant={search().variant}
      onVariantChange={(variant) =>
        navigate({ search: { prototype: search().prototype, variant }, replace: true })
      }
    />
  );
}
