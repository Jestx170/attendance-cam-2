import React, { useState, useEffect } from 'react';
import { MapPin, Navigation, Loader2, Save, Crosshair } from 'lucide-react';
import { motion } from 'framer-motion';

const API_URL = '/api';

function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('admin_token') ?? '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

interface GeoConf {
  lat: number;
  lon: number;
  radius: number;
  name: string;
}

export default function GeoConfigView() {
  const [conf, setConf] = useState<GeoConf>({ lat: 16.4257442, lon: 102.8318782, radius: 100, name: 'AACC' });
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/geofence`)
      .then(r => r.json())
      .then(d => setConf(d))
      .catch(() => {});
  }, []);

  const locateMe = () => {
    if (!navigator.geolocation) { setGeoError('เบราว์เซอร์ไม่รองรับ GPS'); return; }
    setLocating(true);
    setGeoError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCurrentPos({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        });
        setLocating(false);
      },
      (err) => {
        setGeoError(err.code === GeolocationPositionError.PERMISSION_DENIED ? 'GPS ถูกปฏิเสธ' : 'ไม่สามารถระบุตำแหน่งได้');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  const useCurrentAsTarget = () => {
    if (!currentPos) return;
    setConf(c => ({ ...c, lat: currentPos.lat, lon: currentPos.lon }));
  };

  const haversine = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180, Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  };

  const distanceToTarget = currentPos ? haversine(currentPos.lat, currentPos.lon, conf.lat, conf.lon) : null;

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await adminFetch(`${API_URL}/admin/geofence`, {
        method: 'POST',
        body: JSON.stringify(conf),
      });
      const d = await res.json();
      setMessage(d.status === 'updated' ? 'บันทึกเรียบร้อย' : 'เกิดข้อผิดพลาด');
    } catch {
      setMessage('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    }
    setTimeout(() => setMessage(''), 3000);
    setSaving(false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 w-full max-w-[95vw] sm:max-w-2xl mx-auto">

      {/* Current position card */}
      <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden">
        <div className="p-8 border-b border-zinc-50 flex items-center gap-3 bg-gradient-to-r from-sky-50 to-zinc-50">
          <Crosshair size={20} className="text-sky-500" />
          <h3 className="text-lg font-black tracking-tight">ระบุพิกัดปัจจุบัน</h3>
        </div>
        <div className="p-8 space-y-6">
          <button
            onClick={locateMe}
            disabled={locating}
            className="w-full py-5 bg-sky-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-sky-700 transition-all shadow-xl shadow-sky-500/25 disabled:bg-zinc-200 flex items-center justify-center gap-2 text-sm"
          >
            {locating ? <><Loader2 className="animate-spin w-5 h-5" /> กำลังค้นหา GPS…</> : <><Navigation size={18} /> ระบุตำแหน่งของฉัน</>}
          </button>

          {geoError && <p className="text-rose-500 text-xs font-bold text-center">{geoError}</p>}

          {currentPos && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-sky-50 rounded-2xl p-4 text-center">
                  <div className="text-[10px] font-black uppercase tracking-widest text-sky-400 mb-1">Latitude</div>
                  <div className="font-mono text-sky-700 font-bold text-sm">{currentPos.lat.toFixed(7)}</div>
                </div>
                <div className="bg-sky-50 rounded-2xl p-4 text-center">
                  <div className="text-[10px] font-black uppercase tracking-widest text-sky-400 mb-1">Longitude</div>
                  <div className="font-mono text-sky-700 font-bold text-sm">{currentPos.lon.toFixed(7)}</div>
                </div>
              </div>
              <div className="flex gap-4 text-center">
                <div className="flex-1 bg-zinc-50 rounded-2xl p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-1">ความแม่นยำ GPS</div>
                  <div className="font-mono text-zinc-700 font-bold text-sm">±{currentPos.accuracy} ม.</div>
                </div>
                {distanceToTarget !== null && (
                  <div className={`flex-1 rounded-2xl p-3 ${distanceToTarget <= conf.radius ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                    <div className={`text-[10px] font-black uppercase tracking-widest mb-1 ${distanceToTarget <= conf.radius ? 'text-emerald-400' : 'text-amber-400'}`}>ห่างจากเป้าหมาย</div>
                    <div className={`font-mono font-bold text-sm ${distanceToTarget <= conf.radius ? 'text-emerald-700' : 'text-amber-700'}`}>{distanceToTarget} ม.</div>
                  </div>
                )}
              </div>
              <button
                onClick={useCurrentAsTarget}
                className="w-full py-3 border-2 border-dashed border-sky-300 text-sky-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-sky-50 transition-all flex items-center justify-center gap-2"
              >
                <MapPin size={14} /> ใช้ตำแหน่งนี้เป็นพิกัดบริษัท
              </button>
            </motion.div>
          )}
        </div>
      </div>

      {/* Geofence config card */}
      <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden">
        <div className="p-8 border-b border-zinc-50 flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-zinc-50">
          <MapPin size={20} className="text-indigo-500" />
          <h3 className="text-lg font-black tracking-tight">พิกัดพื้นที่บริษัท</h3>
        </div>
        <div className="p-8 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">ชื่อสถานที่</label>
              <input
                type="text"
                value={conf.name}
                onChange={e => setConf(c => ({ ...c, name: e.target.value }))}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-base text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">รัศมี (เมตร)</label>
              <input
                type="number"
                value={conf.radius}
                onChange={e => setConf(c => ({ ...c, radius: parseInt(e.target.value) || 100 }))}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-base text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
                min="10" max="2000"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">Latitude</label>
              <input
                type="number"
                step="0.0000001"
                value={conf.lat}
                onChange={e => setConf(c => ({ ...c, lat: parseFloat(e.target.value) || 0 }))}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-base text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-2">Longitude</label>
              <input
                type="number"
                step="0.0000001"
                value={conf.lon}
                onChange={e => setConf(c => ({ ...c, lon: parseFloat(e.target.value) || 0 }))}
                className="w-full p-4 border border-zinc-200 rounded-2xl font-mono text-base text-center focus:border-indigo-500 focus:ring-4 ring-indigo-500/10 outline-none transition-all"
              />
            </div>
          </div>

          <div className="bg-zinc-50 rounded-2xl p-4 text-xs text-zinc-500 font-mono text-center">
            {conf.name} · {conf.lat.toFixed(7)}, {conf.lon.toFixed(7)} · รัศมี {conf.radius} ม.
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="w-full py-6 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-500/25 disabled:bg-zinc-200 flex items-center justify-center gap-2 text-lg"
          >
            {saving ? <Loader2 className="animate-spin w-5 h-5" /> : <><Save size={20} /> บันทึกพิกัด</>}
          </button>

          {message && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`p-4 rounded-2xl text-center font-bold text-sm ${message === 'บันทึกเรียบร้อย' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-rose-100 text-rose-700 border border-rose-200'}`}
            >
              {message}
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
