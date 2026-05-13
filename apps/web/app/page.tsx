import { redirect } from "next/navigation";

/**
 * The threads index is the application's entry point. Anyone landing on
 * `/` is bounced to `/threads`, which lets them either continue an
 * existing thread or start a new one.
 */
export default function HomePage() {
  redirect("/threads");
}
