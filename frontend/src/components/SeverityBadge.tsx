interface Props { severity: string }

const map: Record<string, string> = {
  P0: 'bg-red-600 text-white',
  P1: 'bg-orange-500 text-white',
  P2: 'bg-yellow-500 text-gray-900',
  P3: 'bg-gray-500 text-white',
};

export default function SeverityBadge({ severity }: Props) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase ${map[severity] || 'bg-gray-600 text-white'}`}>
      {severity}
    </span>
  );
}
