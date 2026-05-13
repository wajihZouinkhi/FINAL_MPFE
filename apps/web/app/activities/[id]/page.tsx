import ActivityViewerPage from "./view";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Public read-only viewer for a single activity row, keyed by
 * `activities.id`.
 *
 * Entry point: the deep-agent supervisor embeds inline `<artifact
 * kind="worksheet" id="<activity_id>" />` chips in chat. Clicking
 * the chip navigates here.
 */
export default async function ActivityPage({ params }: PageProps) {
  const { id } = await params;
  return <ActivityViewerPage activityId={id} />;
}
