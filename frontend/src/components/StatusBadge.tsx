interface Props { status: string }

const map: Record<string, string> = {
  OPEN: 'bg-red-500/20 text-red-400 ring-red-500/30',
  INVESTIGATING: 'bg-blue-500/20 text-blue-400 ring-blue-500/30',
  RESOLVED: 'bg-green-500/20 text-green-400 ring-green-500/30',
  CLOSED: 'bg-gray-500/20 text-gray-400 ring-gray-500/30',
};

export default function StatusBadge({ status }: Props) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${map[status] || 'bg-gray-700 text-gray-300'}`}>
      {status}
    </span>
  );
}
