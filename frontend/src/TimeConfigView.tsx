import React, { useState, useEffect } from 'react';
import { Clock, Save, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

const API_URL = '/api';

function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('admin_token') ?? '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

interface TimeConfig {
  checkin_before: string;  // "HH:MM:SS"
  late_cutoff: string;
  checkout_after: string;
  cooldown_seconds: number;
}

export default function TimeConfigView() {
  const [config, setConfig] = useState<TimeConfig>({ checkin_before: "08:00:00", late_cutoff: "09:00:00", checkout_after: "17:00:00", cooldown_seconds: 300 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const normalizeConfig = (raw: any): TimeConfig => {
    const toHMS = (v: any): string => {
      if (typeof v === 'string' && v.includes(':')) return v;
      const h = parseInt(v) || 0;
      return `${String(h).padStart(2, '0')}:00:00`;
    };
    return {
      checkin_before: toHMS(raw.checkin_before),
      late_cutoff: toHMS(raw.late_cutoff),
      checkout_after: toHMS(raw.checkout_after),
      cooldown_seconds: raw.cooldown_seconds ?? 300,
    };
  };

  useEffect(() => {
    adminFetch(`${API_URL}/admin/config`)
      .then(r => r.json())
      .then(raw => setConfig(normalizeConfig(raw)))
      .catch(() => {});
  }, []);

  const saveConfig = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await adminFetch(`${API_URL}/admin/config`, {
        method: 'POST',
        body: JSON.stringify(config),
      });
      const data = await res.json();
      setMessage(data.status === 'updated' ? 'บันทึกเรียบร้อย' : 'เกิดข้อผิดพลาด');
    } catch (err) {
      setMessage('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    }
    setTimeout(() => setMessage(''), 3000);
    setSaving(false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 w-full max-w-[95vw] sm:max-w-2xl mx-auto">
      <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden touch-friendly">
        <div className="p-8 border-b border-zinc-50 flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-zinc-50">
          <Clock size={20} className="text-indigo-500" />
          <h3 className="text-lg font-black tracking-tight">กำหนดเงื่อนไขเวลา</h3>
        </div>
        
        <div className="p-8 space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8">
            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">เช็คอินปกติ (ก่อนเวลา)</label>
              <input
                type="time"
                step="1"
                value={config.checkin_before}
                onChange={(e) => setConfig({...config, checkin_before: e.target.value })}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-lg text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
              />
              <p className="text-xs text-zinc-400 mt-1 text-center">เข้าก่อนเวลานี้ = Check-In ปกติ</p>
            </div>

            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">ตัดเช็คสาย (หลังเวลา)</label>
              <input
                type="time"
                step="1"
                value={config.late_cutoff}
                onChange={(e) => setConfig({...config, late_cutoff: e.target.value })}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-lg text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
              />
              <p className="text-xs text-zinc-400 mt-1 text-center">เข้าตั้งแต่เวลานี้ขึ้นไป = Check-In (Late)</p>
            </div>

            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">เช็คเอาท์ (หลังเวลา)</label>
              <input
                type="time"
                step="1"
                value={config.checkout_after}
                onChange={(e) => setConfig({...config, checkout_after: e.target.value })}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-lg text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
              />
              <p className="text-xs text-zinc-400 mt-1 text-center">หลังเวลานี้ = Check-Out</p>
            </div>

            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">Cooldown (วินาที)</label>
              <input
                type="number"
                value={config.cooldown_seconds}
                onChange={(e) => setConfig({...config, cooldown_seconds: parseInt(e.target.value) || 300 })}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-lg text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
                min="60" max="3600"
              />
              <p className="text-xs text-zinc-400 mt-1 text-center">ป้องกันสแกนซ้ำ (5นาที = 300)</p>
            </div>
          </div>

          <div className="flex gap-4 pt-4 border-t border-zinc-100">
            <button
              onClick={saveConfig}
              disabled={saving}
              className="flex-1 py-6 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-500/25 disabled:bg-zinc-200 flex items-center justify-center gap-2 text-lg"
            >
              {saving ? <Loader2 className="animate-spin w-5 h-5" /> : <><Save size={20} /> บันทึกการตั้งค่า</>}
            </button>
          </div>

          {message && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`p-4 rounded-2xl text-center font-bold text-sm ${message === 'บันทึกเรียบร้อย' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-rose-100 text-rose-700 border border-rose-200'}`}
            >
              {message}
            </motion.div>
          )}

            <div className="text-[11px] text-zinc-400 text-center font-mono">
              Check-In {'<'} {config.checkin_before.slice(0,5)} | Check-In (Late) {config.checkin_before.slice(0,5)}–{config.checkout_after.slice(0,5)} | Check-Out ≥ {config.checkout_after.slice(0,5)}
            </div>
        </div>
      </div>
    </motion.div>
  );
}
