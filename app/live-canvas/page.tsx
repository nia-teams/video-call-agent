import LiveCanvas from './panel';
export default async function LiveCanvasPage({ searchParams }: { searchParams: Promise<{ sourceRevision?: string }> }) {
  const { sourceRevision } = await searchParams;
  return <LiveCanvas sourceRevision={Number(sourceRevision) || 0}/>;
}
