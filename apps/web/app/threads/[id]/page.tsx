import ThreadDispatch from "./dispatch";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ThreadPage({ params }: PageProps) {
  const { id } = await params;
  return <ThreadDispatch threadId={id} />;
}
