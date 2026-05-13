import SyllabusViewerPage from "./view";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Public read-only viewer for a syllabus, keyed by `syllabuses.id`.
 *
 * Entry point: the deep-agent supervisor embeds inline `<artifact
 * kind="syllabus" id="<syllabus_id>" />` chips in chat. Clicking the
 * chip navigates here. The page is intentionally not chat-aware —
 * the same syllabus may have been produced by any thread (even from
 * a non-deep-agent thread in the future), so this surface is
 * decoupled from `app/threads/[id]/`.
 */
export default async function SyllabusPage({ params }: PageProps) {
  const { id } = await params;
  return <SyllabusViewerPage syllabusId={id} />;
}
