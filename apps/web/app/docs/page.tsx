import { redirect } from "next/navigation";

/** Redirect bare `/docs` to the agents index. */
export default function DocsHomePage(): never {
  redirect("/docs/agents");
}
