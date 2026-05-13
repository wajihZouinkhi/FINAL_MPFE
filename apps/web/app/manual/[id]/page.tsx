import ManualWorkspaceView from "./view";

export default async function ManualWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ManualWorkspaceView syllabusId={id} />;
}
