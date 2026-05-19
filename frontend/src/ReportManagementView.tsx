import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart2, Clock, FileText, Users, User,
  AlertCircle, Loader2, RotateCcw, Filter,
} from 'lucide-react';
import { motion } from 'framer-motion';

const API_URL = '/api';

function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('admin_token') ?? '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface AttendanceLog {
  name: string;
  action: string;
  time: string;
  date: string; // YYYY-MM-DD
}

export interface TimeConfig {
  checkin_before: number;
  late_cutoff: number;
  checkout_after: number;
  cooldown_seconds: number;
}

export interface ReportData {
  date: string;
  name: string;
  checkIn: string | null;
  checkOut: string | null;
  workMinutes: number | null;
  isLate: boolean;
  status: 'on-time' | 'late' | 'absent';
}

export interface FilterState {
  year: string;
  month: string; // "01"–"12" or ""
  day: string;   // "01"–"31" or ""
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES_TH = [
  '', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToDisplay(mins: number): string {
  if (mins <= 0) return '0h 00m';
  return `${Math.floor(mins / 60)}h ${(mins % 60).toString().padStart(2, '0')}m`;
}

function processLogs(logs: AttendanceLog[]): ReportData[] {
  type Entry = { date: string; name: string; checkIn?: AttendanceLog; checkOut?: AttendanceLog };
  const map = new Map<string, Entry>();

  for (const log of logs) {
    const key = `${log.date}::${log.name}`;
    if (!map.has(key)) map.set(key, { date: log.date, name: log.name });
    const entry = map.get(key)!;
    if (log.action.includes('In') && !entry.checkIn) entry.checkIn = log;
    if (log.action.includes('Out') && !entry.checkOut) entry.checkOut = log;
  }

  return Array.from(map.values())
    .map(({ date, name, checkIn, checkOut }) => {
      const isLate = checkIn?.action.includes('Late') ?? false;
      let workMinutes: number | null = null;
      if (checkIn?.time && checkOut?.time) {
        const diff = timeToMinutes(checkOut.time) - timeToMinutes(checkIn.time);
        if (diff > 0) workMinutes = diff;
      }
      return {
        date,
        name,
        checkIn: checkIn?.time ?? null,
        checkOut: checkOut?.time ?? null,
        workMinutes,
        isLate,
        status: (checkIn ? (isLate ? 'late' : 'on-time') : 'absent') as ReportData['status'],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ReportData['status'] }) {
  const cfg = {
    'on-time': { cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500', label: 'ตรงเวลา' },
    'late':    { cls: 'bg-amber-100 text-amber-700',   dot: 'bg-amber-500',   label: 'สาย'     },
    'absent':  { cls: 'bg-zinc-100 text-zinc-400',     dot: 'bg-zinc-300',    label: 'ขาด'     },
  }[status];

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ message = 'ไม่พบข้อมูลในช่วงเวลาที่เลือก' }: { message?: string }) {
  return (
    <div className="py-20 text-center text-zinc-300 italic text-sm uppercase tracking-widest">
      {message}
    </div>
  );
}

// ─── Summary Table ────────────────────────────────────────────────────────────

type SummaryRowData = { name: string; totalDays: number; lateDays: number; totalWork: number };

function SummaryTable({ rows }: { rows: SummaryRowData[] }) {
  if (rows.length === 0) return <EmptyState />;

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-zinc-50">
          {['ชื่อพนักงาน', 'วันที่เข้างาน', 'รวมวันสาย', 'รวมชั่วโมง', 'อัตราสาย'].map(h => (
            <th key={h} className="text-left px-8 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 whitespace-nowrap">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-50">
        {rows.map((row, i) => {
          const lateRate = row.totalDays > 0 ? (row.lateDays / row.totalDays) * 100 : 0;
          return (
            <tr key={i} className="hover:bg-zinc-50/50 transition-colors group">
              <td className="px-8 py-5">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-zinc-100 rounded-full flex items-center justify-center text-xs font-black text-zinc-500 group-hover:bg-indigo-100 group-hover:text-indigo-600 transition-colors">
                    {row.name.charAt(0)}
                  </div>
                  <span className="font-bold text-zinc-800 text-sm">{row.name}</span>
                </div>
              </td>
              <td className="px-8 py-5 font-mono text-sm text-zinc-600">{row.totalDays} วัน</td>
              <td className="px-8 py-5">
                <span className={`text-sm font-bold ${row.lateDays > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>
                  {row.lateDays} วัน
                </span>
              </td>
              <td className="px-8 py-5 font-mono text-sm text-zinc-600">
                {row.totalWork > 0 ? minutesToDisplay(Math.round(row.totalWork)) : '—'}
              </td>
              <td className="px-8 py-5">
                <div className="flex items-center gap-3">
                  <div className="w-20 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${lateRate > 30 ? 'bg-rose-400' : lateRate > 10 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                      style={{ width: `${Math.min(lateRate, 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-bold text-zinc-400">{lateRate.toFixed(0)}%</span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Individual Table ─────────────────────────────────────────────────────────

function IndividualTable({ rows, selectedEmployee }: { rows: ReportData[]; selectedEmployee: string }) {
  if (!selectedEmployee) return <EmptyState message="เลือกพนักงานเพื่อดูรายงาน" />;
  if (rows.length === 0) return <EmptyState />;

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-zinc-50">
          {['วันที่', 'ชื่อ', 'เข้างาน', 'ออกงาน', 'ชั่วโมงทำงาน', 'สถานะ'].map(h => (
            <th key={h} className="text-left px-8 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 whitespace-nowrap">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-50">
        {rows.map((row, i) => (
          <tr key={i} className="hover:bg-zinc-50/50 transition-colors">
            <td className="px-8 py-4 font-mono text-xs text-zinc-400 whitespace-nowrap">{row.date}</td>
            <td className="px-8 py-4">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-zinc-100 rounded-full flex items-center justify-center text-[10px] font-black text-zinc-500 flex-shrink-0">
                  {row.name.charAt(0)}
                </div>
                <span className="text-sm font-bold text-zinc-800">{row.name}</span>
              </div>
            </td>
            <td className="px-8 py-4 font-mono text-sm text-zinc-700">
              {row.checkIn ?? <span className="text-zinc-300">—</span>}
            </td>
            <td className="px-8 py-4 font-mono text-sm text-zinc-700">
              {row.checkOut ?? <span className="text-zinc-300">—</span>}
            </td>
            <td className="px-8 py-4 font-mono text-sm text-zinc-600">
              {row.workMinutes !== null ? minutesToDisplay(row.workMinutes) : <span className="text-zinc-300">—</span>}
            </td>
            <td className="px-8 py-4">
              <StatusBadge status={row.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ReportManagementView() {
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  const [config, setConfig] = useState<TimeConfig>({
    checkin_before: 8, late_cutoff: 9, checkout_after: 17, cooldown_seconds: 300,
  });
  const [loading, setLoading] = useState(true);
  const [reportType, setReportType] = useState<'summary' | 'individual'>('summary');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [filter, setFilter] = useState<FilterState>({
    year: new Date().getFullYear().toString(),
    month: '',
    day: '',
  });

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [logsRes, cfgRes] = await Promise.all([
          fetch(`${API_URL}/logs`),
          adminFetch(`${API_URL}/admin/config`),
        ]);
        if (logsRes.ok) setLogs(await logsRes.json());
        if (cfgRes.ok) setConfig(await cfgRes.json());
      } catch {}
      setLoading(false);
    };
    load();
  }, []);

  const allRows = useMemo(() => processLogs(logs), [logs]);

  const availableYears = useMemo(() => {
    const ys = new Set(allRows.map(r => r.date.slice(0, 4)));
    return Array.from(ys).sort().reverse();
  }, [allRows]);

  const availableMonths = useMemo(() => {
    if (!filter.year) return [];
    const ms = new Set(allRows.filter(r => r.date.startsWith(filter.year)).map(r => r.date.slice(5, 7)));
    return Array.from(ms).sort();
  }, [allRows, filter.year]);

  const availableDays = useMemo(() => {
    if (!filter.year || !filter.month) return [];
    const prefix = `${filter.year}-${filter.month}`;
    const ds = new Set(allRows.filter(r => r.date.startsWith(prefix)).map(r => r.date.slice(8, 10)));
    return Array.from(ds).sort();
  }, [allRows, filter.year, filter.month]);

  const dateFilteredRows = useMemo(() => {
    return allRows.filter(r => {
      if (filter.year && !r.date.startsWith(filter.year)) return false;
      if (filter.month && r.date.slice(5, 7) !== filter.month) return false;
      if (filter.day && r.date.slice(8, 10) !== filter.day) return false;
      return true;
    });
  }, [allRows, filter]);

  const availableEmployees = useMemo(() => {
    const ns = new Set(dateFilteredRows.map(r => r.name));
    return Array.from(ns).sort();
  }, [dateFilteredRows]);

  const displayRows = useMemo(() => {
    if (reportType === 'individual' && selectedEmployee) {
      return dateFilteredRows.filter(r => r.name === selectedEmployee);
    }
    return dateFilteredRows;
  }, [dateFilteredRows, reportType, selectedEmployee]);

  const summaryStats = useMemo(() => {
    const totalRecords = displayRows.length;
    const totalLate = displayRows.filter(r => r.isLate).length;
    const workRows = displayRows.filter(r => r.workMinutes !== null);
    const avgWork = workRows.length > 0
      ? workRows.reduce((s, r) => s + r.workMinutes!, 0) / workRows.length
      : 0;
    return { totalRecords, totalLate, avgWork };
  }, [displayRows]);

  const summaryByEmployee = useMemo<SummaryRowData[]>(() => {
    const map = new Map<string, { totalDays: number; lateDays: number; workMins: number[] }>();
    for (const row of dateFilteredRows) {
      if (!map.has(row.name)) map.set(row.name, { totalDays: 0, lateDays: 0, workMins: [] });
      const e = map.get(row.name)!;
      e.totalDays++;
      if (row.isLate) e.lateDays++;
      if (row.workMinutes !== null) e.workMins.push(row.workMinutes);
    }
    return Array.from(map.entries())
      .map(([name, d]) => ({
        name,
        totalDays: d.totalDays,
        lateDays: d.lateDays,
        totalWork: d.workMins.reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.totalDays - a.totalDays);
  }, [dateFilteredRows]);

  const summaryCards = [
    {
      icon: <FileText size={18} className="text-indigo-500" />,
      label: 'รายการทั้งหมด',
      value: summaryStats.totalRecords,
      sub: 'Total Records',
      from: 'from-indigo-50',
    },
    {
      icon: <AlertCircle size={18} className="text-amber-500" />,
      label: 'รวมวันสาย',
      value: summaryStats.totalLate,
      sub: `${summaryStats.totalRecords > 0 ? ((summaryStats.totalLate / summaryStats.totalRecords) * 100).toFixed(1) : 0}% ของทั้งหมด`,
      from: 'from-amber-50',
    },
    {
      icon: <Clock size={18} className="text-emerald-500" />,
      label: 'ชั่วโมงทำงานเฉลี่ย',
      value: minutesToDisplay(Math.round(summaryStats.avgWork)),
      sub: 'Avg Work Hours',
      from: 'from-emerald-50',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-zinc-300" size={32} />
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">

      {/* Header + Filters */}
      <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden">
        <div className="p-8 border-b border-zinc-50 bg-zinc-50/30 flex flex-wrap gap-6 items-center justify-between">
          <div className="flex items-center gap-3">
            <BarChart2 size={20} className="text-indigo-500" />
            <div>
              <h3 className="font-black uppercase tracking-widest text-sm">รายงานการเข้างาน</h3>
              <p className="text-[10px] text-zinc-400 mt-0.5">Late Cutoff: {config.late_cutoff}:00 น.</p>
            </div>
          </div>

          {/* Report type toggle */}
          <div className="flex bg-zinc-100 rounded-2xl p-1 gap-1">
            <button
              onClick={() => setReportType('summary')}
              className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${reportType === 'summary' ? 'bg-white shadow text-black' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              <Users size={13} /> Summary
            </button>
            <button
              onClick={() => setReportType('individual')}
              className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${reportType === 'individual' ? 'bg-white shadow text-black' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              <User size={13} /> Individual
            </button>
          </div>
        </div>

        {/* Date filter bar */}
        <div className="px-8 py-5 border-b border-zinc-50 flex flex-wrap gap-3 items-center">
          <Filter size={13} className="text-zinc-300" />
          <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">กรอง:</span>

          <select
            value={filter.year}
            onChange={e => setFilter({ year: e.target.value, month: '', day: '' })}
            className="bg-white border border-zinc-200 rounded-xl px-4 py-2 text-xs font-bold outline-none focus:border-black transition-all"
          >
            <option value="">ทุกปี</option>
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>

          {filter.year && (
            <motion.select
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
              value={filter.month}
              onChange={e => setFilter(f => ({ ...f, month: e.target.value, day: '' }))}
              className="bg-white border border-zinc-200 rounded-xl px-4 py-2 text-xs font-bold outline-none focus:border-black transition-all"
            >
              <option value="">ทุกเดือน</option>
              {availableMonths.map(m => (
                <option key={m} value={m}>{MONTH_NAMES_TH[parseInt(m)]} {m}</option>
              ))}
            </motion.select>
          )}

          {filter.month && (
            <motion.select
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
              value={filter.day}
              onChange={e => setFilter(f => ({ ...f, day: e.target.value }))}
              className="bg-white border border-zinc-200 rounded-xl px-4 py-2 text-xs font-bold outline-none focus:border-black transition-all"
            >
              <option value="">ทุกวัน</option>
              {availableDays.map(d => <option key={d} value={d}>{parseInt(d)}</option>)}
            </motion.select>
          )}

          {reportType === 'individual' && (
            <motion.select
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
              value={selectedEmployee}
              onChange={e => setSelectedEmployee(e.target.value)}
              className="bg-white border border-indigo-200 text-indigo-700 rounded-xl px-4 py-2 text-xs font-bold outline-none focus:border-indigo-500 transition-all"
            >
              <option value="">เลือกพนักงาน</option>
              {availableEmployees.map(n => <option key={n} value={n}>{n}</option>)}
            </motion.select>
          )}

          {(filter.year || filter.month || filter.day) && (
            <button
              onClick={() => setFilter({ year: '', month: '', day: '' })}
              className="flex items-center gap-1.5 text-[10px] font-bold text-zinc-300 hover:text-zinc-600 transition-colors"
            >
              <RotateCcw size={11} /> ล้างตัวกรอง
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {summaryCards.map((card, i) => (
          <div key={i} className={`bg-gradient-to-br ${card.from} to-white rounded-[2rem] border border-zinc-200/60 shadow-sm p-7 flex items-start gap-4`}>
            <div className="w-10 h-10 bg-white rounded-2xl flex items-center justify-center shadow-sm border border-zinc-100 flex-shrink-0">
              {card.icon}
            </div>
            <div>
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">{card.label}</div>
              <div className="text-3xl font-black text-zinc-900 mt-0.5 leading-none">{card.value}</div>
              <div className="text-[10px] text-zinc-400 mt-1">{card.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Data Table */}
      <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden">
        <div className="p-8 border-b border-zinc-50 bg-zinc-50/30 flex items-center justify-between">
          <h3 className="font-black uppercase tracking-widest text-sm flex items-center gap-2">
            {reportType === 'summary'
              ? <><Users size={15} className="text-zinc-400" /> สรุปรายบุคคล</>
              : <><User size={15} className="text-zinc-400" /> รายละเอียดการเข้างาน</>
            }
          </h3>
          <span className="text-[10px] font-bold text-zinc-300">
            {reportType === 'summary' ? `${summaryByEmployee.length} คน` : `${displayRows.length} รายการ`}
          </span>
        </div>

        <div className="overflow-x-auto custom-scrollbar">
          {reportType === 'summary'
            ? <SummaryTable rows={summaryByEmployee} />
            : <IndividualTable rows={displayRows} selectedEmployee={selectedEmployee} />
          }
        </div>
      </div>
    </motion.div>
  );
}
