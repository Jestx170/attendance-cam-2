import React, { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
import {
  Camera, Trash2,
  UserPlus, X, Loader2, CheckCircle2, AlertCircle,
  Scan, Lock, LogOut, History, Shield, Clock, MapPin, Navigation,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import TimeConfigView from './TimeConfigView';
import ReportManagementView from './ReportManagementView';
import GeoConfigView from './GeoConfigView';
import { useGeofence, GEOFENCE_RADIUS_M, GEOFENCE_TARGET, type GeoStatus } from './hooks/useGeofence';
import './index.css';

const API_URL = "/api";

function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('admin_token') ?? '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

function getActionStyle(action: string) {
  if (action.includes("Late")) return { bg: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-500", hex: "#ca8a04" };
  if (action.includes("Out"))  return { bg: "bg-orange-100 text-orange-700", dot: "bg-orange-500", hex: "#ea580c" };
  return { bg: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500", hex: "#059669" };
}

function App() {
  const [view, setView] = useState<'public' | 'login' | 'admin'>('public');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [stats, setStats] = useState({ total_employees: 0, checkin_today: 0, checkout_today: 0 });
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [currentMode, setCurrentMode] = useState<string>('Check-In');

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshData = async () => {
    try {
      const [stRes, logsRes, statusRes] = await Promise.all([
        fetch(`${API_URL}/stats`),
        fetch(`${API_URL}/logs`),
        fetch(`${API_URL}/status`),
      ]);
      const stData = await stRes.json();
      const logsData: any[] = await logsRes.json();
      const statusData = await statusRes.json();

      const today = new Date().toLocaleDateString('en-CA');
      const todayLogs = logsData.filter(r => r.date === today);
      const checkin_today = todayLogs.filter(r => r.action?.includes("In")).length;
      const checkout_today = todayLogs.filter(r => r.action?.includes("Out")).length;

      setStats({ total_employees: stData.total_employees ?? 0, checkin_today, checkout_today });
      setRecentLogs(logsData.slice(0, 5));
      setCurrentMode(statusData.action ?? 'Check-In');
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    refreshData();
    const timer = setInterval(refreshData, 2000);
    return () => clearInterval(timer);
  }, []);

  const speak = (text: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH';
    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans selection:bg-indigo-100">
      <header className="bg-white/80 backdrop-blur-md border-b border-zinc-200 px-8 py-4 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setView('public')}>
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
              <Scan size={18} className="text-white" />
            </div>
            <span className="font-bold tracking-tight text-lg">Attendance</span>
          </div>

          <div className="flex items-center gap-6">
            <div className="hidden md:flex items-center gap-4 text-xs font-bold">
              <span className="text-emerald-600">{stats.checkin_today} Check-In</span>
              <span className="text-orange-500">{stats.checkout_today} Check-Out</span>
              <span className="text-zinc-400">{stats.total_employees} Staff</span>
            </div>
            <div className="text-right hidden sm:block">
              <div className="text-sm font-bold text-zinc-900">{currentTime.toLocaleTimeString('th-TH', { hour12: false })}</div>
              <div className="text-[10px] font-medium text-zinc-400 uppercase">{currentTime.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</div>
            </div>

            {view === 'public' && (
              <button onClick={() => setView('login')} className="p-2 hover:bg-zinc-100 rounded-full text-zinc-400 transition-colors">
                <Lock size={18} />
              </button>
            )}
            {view === 'admin' && (
              <button onClick={() => { localStorage.removeItem('admin_token'); setView('public'); }} className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white text-xs font-bold rounded-lg hover:bg-zinc-800 transition-all">
                <LogOut size={14} /> ออกจากระบบ
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 md:p-10">
        <AnimatePresence mode="wait">
          {view === 'public' && (
            <PublicAttendanceView key="public" currentMode={currentMode} recentLogs={recentLogs} onScanSuccess={(name, action) => {
              speak(`สวัสดีคุณ ${name} ${action} เรียบร้อยค่ะ`);
              refreshData();
            }} />
          )}
          {view === 'login' && (
            <AdminLoginView key="login" onLoginSuccess={() => setView('admin')} onCancel={() => setView('public')} />
          )}
          {view === 'admin' && (
            <AdminDashboardView key="admin" stats={stats} onUpdate={refreshData} />
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Views ---
function PublicAttendanceView({ currentMode, recentLogs, onScanSuccess }: {
  currentMode: string;
  recentLogs: any[];
  onScanSuccess: (name: string, action: string) => void;
}) {
  const webcamRef = useRef<Webcam>(null);
  const [camPerm, setCamPerm] = useState<'idle' | 'granted' | 'denied' | 'unavailable'>('idle');
  const [checkInStatus, setCheckInStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<any | null>(null);

  const geo = useGeofence();
  useEffect(() => { geo.start(); }, [geo.start]);

  const handleUserMedia = useCallback(() => setCamPerm('granted'), []);
  const handleUserMediaError = useCallback((err: string | DOMException) => {
    const msg = typeof err === 'string' ? err : err.message;
    setCamPerm(msg.toLowerCase().includes('permission') || msg.includes('NotAllowed') ? 'denied' : 'unavailable');
  }, []);

  const handleCheckin = async () => {
    if (checkInStatus === 'submitting') return;
    const image = webcamRef.current?.getScreenshot();
    if (!image) return;
    setCheckInStatus('submitting');
    try {
      const res = await fetch(`${API_URL}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, lat: geo.userLat, lon: geo.userLon, accuracy: geo.accuracy }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') throw new Error(data.message ?? 'ไม่พบข้อมูล');
      setResult({ success: true, name: data.name, action: data.action });
      setCheckInStatus('success');
      onScanSuccess(data.name, data.action ?? 'Check-In');
      setTimeout(() => { setCheckInStatus('idle'); setResult(null); }, 4000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'เชื่อมต่อ Server ไม่ได้';
      setResult({ success: false, message });
      setCheckInStatus('error');
      setTimeout(() => { setCheckInStatus('idle'); setResult(null); }, 3500);
    }
  };

  const canCheckin = geo.isWithinRadius && camPerm === 'granted' && checkInStatus === 'idle';
  const modeStyle = getActionStyle(currentMode);

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="flex flex-col items-center gap-8 py-6">
      <div className="text-center space-y-3">
        <h2 className="text-4xl font-black tracking-tight text-zinc-900">กรุณาสแกนใบหน้า</h2>
        <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold ${modeStyle.bg}`}>
          <span className={`w-2 h-2 rounded-full ${modeStyle.dot}`}></span>
          {currentMode === "Check-In" ? "โหมดเข้างาน" : currentMode === "Check-In (Late)" ? "โหมดเข้างาน (สาย)" : "โหมดออกงาน"}
        </div>
      </div>

      {/* Camera frame — portrait, centered, phone-friendly */}
      <div className="w-full max-w-sm mx-auto bg-white p-4 rounded-[2.5rem] shadow-2xl border border-zinc-200/60 overflow-hidden">
        <div className="relative aspect-[3/4] rounded-[2rem] overflow-hidden bg-zinc-900">
          <Webcam
            ref={webcamRef}
            audio={false}
            screenshotFormat="image/jpeg"
            screenshotQuality={0.92}
            mirrored
            className="w-full h-full object-cover"
            onUserMedia={handleUserMedia}
            onUserMediaError={handleUserMediaError}
            videoConstraints={{ facingMode: 'user', aspectRatio: 3 / 4 }}
          />

          {/* GPS status pill */}
          <div className="absolute top-4 left-4 right-4">
            <GeoStatusPill status={geo.status} distance={geo.distance} isWithinRadius={geo.isWithinRadius} />
          </div>

          {/* Geofence lock overlay */}
          {geo.status === 'granted' && !geo.isWithinRadius && (
            <div className="absolute inset-0 bg-zinc-900/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3 pointer-events-none">
              <div className="w-16 h-16 rounded-full border border-red-500/40 bg-red-500/20 flex items-center justify-center">
                <MapPin size={28} className="text-red-400" />
              </div>
              <p className="text-white text-sm font-bold">อยู่นอกพื้นที่</p>
              <p className="text-zinc-400 text-xs">เข้ามาอีก <span className="text-white font-bold">{geo.distance !== null ? geo.distance - GEOFENCE_RADIUS_M : '…'} ม.</span> เพื่อปลดล็อก</p>
            </div>
          )}

          {/* Camera denied */}
          {camPerm === 'denied' && (
            <div className="absolute inset-0 bg-zinc-900 flex flex-col items-center justify-center gap-3 p-6">
              <Camera size={32} className="text-zinc-500" />
              <p className="text-white text-sm font-bold text-center">กรุณาอนุญาตการใช้กล้อง</p>
              <p className="text-zinc-400 text-xs text-center">Settings → Site Permissions → Camera → Allow</p>
            </div>
          )}

          {/* Camera unavailable */}
          {camPerm === 'unavailable' && (
            <div className="absolute inset-0 bg-zinc-900 flex flex-col items-center justify-center gap-3 p-6">
              <Camera size={32} className="text-zinc-600" />
              <p className="text-zinc-300 text-sm font-bold">ไม่พบกล้อง</p>
              <p className="text-zinc-500 text-xs">ตรวจสอบว่ากล้องไม่ถูกใช้โดย App อื่น</p>
            </div>
          )}

          {/* GPS denied banner */}
          {geo.status === 'denied' && (
            <div className="absolute bottom-4 inset-x-4 bg-amber-500/90 backdrop-blur rounded-xl px-4 py-3 flex items-center gap-3">
              <Navigation size={15} className="text-white flex-shrink-0" />
              <p className="text-white text-xs font-bold">GPS ถูกปฏิเสธ — เปิด Location ใน Browser Settings แล้วรีโหลด</p>
            </div>
          )}

          {/* Result overlay */}
          <AnimatePresence>
            {result && (
              <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="absolute inset-0 flex items-center justify-center bg-white/95 backdrop-blur-md p-8">
                <div className="text-center">
                  {result.success ? (
                    <>
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                        className={`w-24 h-24 mx-auto mb-6 rounded-full flex items-center justify-center shadow-lg ${getActionStyle(result.action ?? currentMode).bg}`}>
                        <CheckCircle2 size={48} />
                      </motion.div>
                      <h3 className="text-3xl font-black tracking-tight text-zinc-900 mb-2">{result.name}</h3>
                      <p className="text-sm font-bold uppercase tracking-[0.2em]" style={{ color: getActionStyle(result.action ?? currentMode).hex }}>
                        {result.action ?? currentMode} สำเร็จ
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="w-24 h-24 mx-auto mb-6 rounded-full flex items-center justify-center shadow-lg bg-rose-50 text-rose-500">
                        <AlertCircle size={48} />
                      </div>
                      <h3 className="text-2xl font-black tracking-tight text-zinc-900 mb-2">ไม่พบข้อมูล</h3>
                      <p className="text-sm font-bold text-zinc-400">{result.message}</p>
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Scan progress bar */}
          {checkInStatus === 'submitting' && (
            <motion.div
              className="absolute bottom-0 inset-x-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-500"
              animate={{ backgroundPosition: ['0% 0%', '100% 0%'] }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            />
          )}
        </div>

        {/* Check-In Button */}
        <div className="pt-4 space-y-3">
          <button
            onClick={handleCheckin}
            disabled={!canCheckin}
            className={`w-full py-5 rounded-2xl font-black text-sm uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
              canCheckin
                ? 'bg-black text-white hover:bg-zinc-800 shadow-xl shadow-black/20 active:scale-[0.98]'
                : 'bg-zinc-100 text-zinc-300 cursor-not-allowed'
            }`}
          >
            {checkInStatus === 'submitting' ? (
              <><Loader2 className="animate-spin" size={18} /> กำลังยืนยันตัวตน…</>
            ) : geo.status === 'requesting' || geo.status === 'idle' ? (
              <><Navigation size={18} /> กำลังตรวจสอบ GPS…</>
            ) : geo.status === 'denied' ? (
              <><Navigation size={18} /> GPS ถูกปฏิเสธ</>
            ) : !geo.isWithinRadius && geo.distance !== null ? (
              <><MapPin size={18} /> ห่างจากจุดเช็คอิน {geo.distance} ม.</>
            ) : camPerm === 'denied' ? (
              <><Camera size={18} /> กล้องถูกปฏิเสธ</>
            ) : camPerm !== 'granted' ? (
              <><Camera size={18} /> รอกล้อง…</>
            ) : (
              <><Camera size={18} /> ยืนยันเช็คอิน</>
            )}
          </button>
          <div className="flex items-center justify-center gap-1.5 text-zinc-300">
            <Shield size={11} />
            <span className="text-[10px] font-medium">พิกัด GPS ยืนยันบน Server ป้องกัน GPS Spoofing</span>
          </div>
        </div>
      </div>

      {recentLogs.length > 0 && (
        <div className="w-full max-w-3xl bg-white rounded-[2rem] border border-zinc-200/60 shadow-sm overflow-hidden">
          <div className="px-8 py-5 border-b border-zinc-50 flex items-center gap-3">
            <History size={16} className="text-zinc-400" />
            <span className="text-xs font-black uppercase tracking-widest text-zinc-600">กิจกรรมล่าสุด</span>
          </div>
          <div className="divide-y divide-zinc-50">
            {recentLogs.map((log, idx) => {
              const style = getActionStyle(log.action ?? "");
              return (
                <div key={idx} className="px-8 py-4 flex justify-between items-center">
                  <div className="flex items-center gap-4">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold ${style.bg}`}>
                      {log.name?.charAt(0)}
                    </div>
                    <span className="font-bold text-zinc-800 text-sm">{log.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black ${style.bg}`}>{log.action}</span>
                    <span className="text-[11px] font-mono text-zinc-400">{log.time}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function GeoStatusPill({ status, distance, isWithinRadius }: { status: GeoStatus; distance: number | null; isWithinRadius: boolean }) {
  if (status === 'idle' || status === 'requesting') {
    return (
      <div className="bg-white/90 backdrop-blur px-3 py-1.5 rounded-2xl shadow-sm flex items-center gap-2 border border-zinc-200/50 w-fit">
        <Loader2 size={10} className="animate-spin text-zinc-400" />
        <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">ค้นหา GPS…</span>
      </div>
    );
  }
  if (status === 'denied' || status === 'unavailable') {
    return (
      <div className="bg-amber-500/90 backdrop-blur px-3 py-1.5 rounded-2xl flex items-center gap-2 w-fit">
        <Navigation size={10} className="text-white" />
        <span className="text-[10px] font-black text-white uppercase tracking-widest">GPS ถูกปฏิเสธ</span>
      </div>
    );
  }
  return (
    <div className={`bg-white/90 backdrop-blur px-3 py-1.5 rounded-2xl shadow-sm flex items-center gap-2 border border-zinc-200/50 w-fit`}>
      <div className={`w-2 h-2 rounded-full animate-pulse ${isWithinRadius ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <span className={`text-[10px] font-black uppercase tracking-widest ${isWithinRadius ? 'text-emerald-700' : 'text-red-600'}`}>
        {isWithinRadius ? `อยู่ในพื้นที่ · ${distance} ม.` : `นอกพื้นที่ · ${distance} ม.`}
      </span>
    </div>
  );
}

function AdminLoginView({ onLoginSuccess, onCancel }: { onLoginSuccess: () => void, onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('admin_token', data.token ?? '');
        onLoginSuccess();
      } else setError(data.detail || "เข้าสู่ระบบไม่สำเร็จ");
    } catch (err) { setError("เชื่อมต่อ Server ไม่ได้"); }
    finally { setLoading(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="max-w-md mx-auto py-20 flex flex-col items-center">
      <div className="w-16 h-16 bg-zinc-100 rounded-2xl flex items-center justify-center mb-8 text-zinc-400">
        <Shield size={32} />
      </div>
      <h2 className="text-2xl font-black tracking-tight text-zinc-900 mb-2">Admin Access</h2>
      <p className="text-zinc-400 text-sm font-medium mb-10">กรุณากรอกรหัสผ่านเพื่อเข้าหน้าจัดการ</p>

      <form onSubmit={handleLogin} className="w-full space-y-4">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="w-full bg-white border border-zinc-200 rounded-2xl p-5 text-center text-xl focus:border-black outline-none transition-all shadow-sm" autoFocus />
        {error && <p className="text-rose-500 text-center text-xs font-bold">{error}</p>}
        <button disabled={loading} className="w-full py-5 bg-black text-white rounded-2xl font-black uppercase tracking-widest hover:bg-zinc-800 transition-all shadow-xl shadow-black/10 disabled:bg-zinc-200">
          {loading ? <Loader2 className="animate-spin mx-auto" /> : 'Enter System'}
        </button>
        <button type="button" onClick={onCancel} className="w-full py-4 text-xs font-bold text-zinc-400 uppercase tracking-widest hover:text-zinc-800 transition-colors">Cancel</button>
      </form>
    </motion.div>
  );
}

function AdminDashboardView({ onUpdate }: { stats: any, onUpdate: () => void }) {
  const [tab, setTab] = useState<'logs' | 'employees' | 'times' | 'geo' | 'odoo' | 'reports'>('logs');

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-10">
      <div className="flex flex-col md:flex-row justify-between items-end gap-6">
        <div>
          <h2 className="text-4xl font-black tracking-tight text-zinc-900">Admin Controller</h2>
          <p className="text-zinc-400 font-medium mt-1">จัดการพนักงานและประวัติการสแกนใบหน้า</p>
        </div>
        <div className="flex bg-white p-1 rounded-2xl border border-zinc-200 shadow-sm max-w-full overflow-x-auto custom-scrollbar">
          <div className="flex flex-nowrap">
            <TabButton active={tab === 'logs'} onClick={() => setTab('logs')} label="ประวัติเข้างาน" />
            <TabButton active={tab === 'employees'} onClick={() => setTab('employees')} label="พนักงาน" />
            <TabButton active={tab === 'times'} onClick={() => setTab('times')} label="กำหนดเวลา" />
            <TabButton active={tab === 'geo'} onClick={() => setTab('geo')} label="พิกัด" />
            <TabButton active={tab === 'odoo'} onClick={() => setTab('odoo')} label="Odoo" />
            <TabButton active={tab === 'reports'} onClick={() => setTab('reports')} label="รายงาน" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        <div className="lg:col-span-12">
          {tab === 'logs' && <HistoryLogsView onUpdate={onUpdate} />}
          {tab === 'employees' && <EmployeeManagementView onUpdate={onUpdate} />}
          {tab === 'times' && <TimeConfigView />}
          {tab === 'geo' && <GeoConfigView />}
          {tab === 'odoo' && <OdooConfigView />}
          {tab === 'reports' && <ReportManagementView />}
        </div>
      </div>
    </motion.div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all whitespace-nowrap ${
        active ? 'bg-zinc-100 text-black shadow-inner' : 'text-zinc-400 hover:text-zinc-600'
      }`}
    >
      {label}
    </button>
  );
}

function OdooConfigView() {
  const [form, setForm] = useState({ url: '', db: '', username: '', api_key: 'ca802f28bd3c0212cb39e0e376fa0d0f3dbc3bb3' });
  const [odooStatus, setOdooStatus] = useState<{ connected: boolean; url: string; db: string; username: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [error, setError] = useState('');

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/odoo/status`);
      const data = await res.json();
      setOdooStatus(data);
      if (data.url) setForm(f => ({ ...f, url: data.url, db: data.db, username: data.username }));
    } catch {}
  };

  const save = async () => {
    setSaving(true); setError(''); setTestResult(null);
    try {
      const res = await adminFetch(`${API_URL}/odoo/config`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.connected) setError('เชื่อมต่อ Odoo ไม่สำเร็จ — ตรวจสอบ URL / DB / Username');
      await fetchStatus();
    } catch { setError('ไม่สามารถบันทึกได้'); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setTestResult(null); setError('');
    try {
      const res = await adminFetch(`${API_URL}/odoo/test`, { method: 'POST' });
      if (res.ok) { const data = await res.json(); setTestResult(data.sample_employees); }
      else { const data = await res.json(); setError(data.detail || 'Test failed'); }
    } catch { setError('Test error'); }
    finally { setTesting(false); }
  };

  useEffect(() => { fetchStatus(); }, []);

  const field = (key: keyof typeof form, label: string, placeholder: string, type = 'text') => (
    <div className="space-y-2">
      <label className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">{label}</label>
      <input
        type={type}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl px-6 py-4 font-mono text-sm outline-none focus:border-black transition-all"
      />
    </div>
  );

  return (
    <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden">
      <div className="p-8 border-b border-zinc-50 flex items-center justify-between bg-zinc-50/30">
        <h3 className="font-black uppercase tracking-widest text-sm">Odoo Attendance Sync</h3>
        {odooStatus && (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold ${odooStatus.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-400'}`}>
            <span className={`w-2 h-2 rounded-full ${odooStatus.connected ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-300'}`}></span>
            {odooStatus.connected ? 'เชื่อมต่อแล้ว' : 'ไม่ได้เชื่อมต่อ'}
          </div>
        )}
      </div>

      <div className="p-8 space-y-5">
        {field('url', 'Odoo URL', 'https://mycompany.odoo.com')}
        {field('db', 'Database Name', 'mycompany')}
        {field('username', 'Username / Email', 'admin@company.com')}
        {field('api_key', 'API Key', '••••••••••••••', 'password')}

        {error && <p className="text-rose-500 text-xs font-bold">{error}</p>}

        <div className="flex gap-4 pt-2">
          <button
            onClick={save}
            disabled={saving || !form.url || !form.db || !form.username}
            className="flex-1 py-4 bg-black text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-zinc-800 disabled:bg-zinc-200 transition-all flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="animate-spin" size={16} /> : 'บันทึกและเชื่อมต่อ'}
          </button>
          {odooStatus?.connected && (
            <button
              onClick={test}
              disabled={testing}
              className="px-8 py-4 border border-zinc-200 text-zinc-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-zinc-50 transition-all flex items-center gap-2"
            >
              {testing ? <Loader2 className="animate-spin" size={14} /> : 'ทดสอบ'}
            </button>
          )}
        </div>

        {testResult && (
          <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-3">พนักงานใน Odoo (ตัวอย่าง)</p>
            <div className="space-y-2">
              {testResult.map((emp: any) => (
                <div key={emp.id} className="flex items-center gap-3 text-sm">
                  <span className="w-6 h-6 bg-emerald-100 rounded-lg flex items-center justify-center text-[10px] font-bold text-emerald-600">{emp.name.charAt(0)}</span>
                  <span className="font-medium text-zinc-700">{emp.name}</span>
                  <span className="text-zinc-300 text-xs">#{emp.id}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-zinc-50 rounded-2xl p-5 text-xs text-zinc-400 space-y-1">
          <p className="font-bold text-zinc-500">วิธีการทำงาน</p>
          <p>• เมื่อสแกนหน้าสำเร็จ ระบบจะ push ข้อมูลไป Odoo อัตโนมัติ</p>
          <p>• Check-In → สร้าง attendance record ใน Odoo</p>
          <p>• Check-Out → อัปเดต check_out ของ record ที่เปิดค้างอยู่</p>
          <p>• ชื่อพนักงานต้องตรงกับที่ลงทะเบียนใน Odoo</p>
        </div>
      </div>
    </div>
  );
}

function HistoryLogsView({ onUpdate }: { onUpdate: () => void }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [odooConnected, setOdooConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const fetchLogs = async () => {
    try {
      const res = await fetch(`${API_URL}/logs`);
      setLogs(await res.json());
    } catch (err) { console.error(err); }
  };

  const clearLogs = async () => {
    if (!confirm("ล้างประวัติทั้งหมด?")) return;
    await adminFetch(`${API_URL}/logs`, { method: 'DELETE' });
    fetchLogs();
    onUpdate();
  };

  const syncOdoo = async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const res = await adminFetch(`${API_URL}/odoo/sync`, { method: 'POST' });
      const d = await res.json();
      setSyncMsg(d.added > 0 ? `เพิ่ม ${d.added} รายการจาก Odoo` : 'ข้อมูลเป็นปัจจุบันแล้ว');
      fetchLogs();
      onUpdate();
    } catch { setSyncMsg('Sync ไม่สำเร็จ'); }
    finally { setSyncing(false); setTimeout(() => setSyncMsg(''), 3000); }
  };

  useEffect(() => {
    fetchLogs();
    fetch(`${API_URL}/odoo/status`).then(r => r.json()).then(d => setOdooConnected(d.connected)).catch(() => {});
  }, []);

  return (
    <div className="bg-white rounded-[2.5rem] border border-zinc-200/60 shadow-sm overflow-hidden flex flex-col">
      <div className="p-8 border-b border-zinc-50 flex justify-between items-center gap-4 flex-wrap bg-zinc-50/30">
        <h3 className="font-black uppercase tracking-widest text-sm flex items-center gap-3">
          <History size={18} className="text-zinc-400" /> ประวัติเข้างาน
        </h3>
        <div className="flex items-center gap-3">
          {syncMsg && <span className="text-[10px] font-bold text-emerald-600">{syncMsg}</span>}
          {odooConnected && (
            <button onClick={syncOdoo} disabled={syncing}
              className="px-4 py-2 border border-zinc-200 text-zinc-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-zinc-50 disabled:opacity-50 transition-all flex items-center gap-1.5">
              {syncing ? <Loader2 className="animate-spin" size={12} /> : null}
              Sync Odoo
            </button>
          )}
          <button onClick={clearLogs} className="text-[10px] font-black uppercase tracking-widest text-zinc-300 hover:text-rose-500 transition-colors">Clear All</button>
        </div>
      </div>

      <div className="p-8 space-y-4 max-h-[600px] overflow-y-auto custom-scrollbar">
        {logs.length === 0 ? (
          <div className="py-20 text-center text-zinc-300 italic text-sm uppercase tracking-widest">No Records Found</div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {logs.map((log, idx) => {
              const style = getActionStyle(log.action ?? "");
              const fromOdoo = String(log.id).startsWith('odoo_');
              return (
                <div key={idx} className="py-5 flex justify-between items-center group transition-colors hover:bg-zinc-50/50 px-4 -mx-4 rounded-xl">
                  <div className="flex items-center gap-5">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-xs ${style.bg}`}>{log.name.charAt(0)}</div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-zinc-800 text-sm">{log.name}</span>
                        {fromOdoo && <span className="text-[8px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-500 px-1.5 py-0.5 rounded-md">Odoo</span>}
                      </div>
                      <span className={`text-[10px] font-black uppercase tracking-tighter px-2 py-0.5 rounded-full ${style.bg}`}>{log.action}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] font-mono font-bold text-zinc-400">{log.time}</div>
                    <div className="text-[9px] font-medium text-zinc-300">{log.date}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EmployeeManagementView({ onUpdate }: { onUpdate: () => void }) {
  const [employees, setEmployees] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [scheduleEmp, setScheduleEmp] = useState<any | null>(null);
  const [addFacesEmp, setAddFacesEmp] = useState<any | null>(null);

  const fetchEmployees = async () => {
    try {
      const res = await fetch(`${API_URL}/employees`);
      const data = await res.json();
      setEmployees(data);
    } catch (err) { console.error(err); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("ลบพนักงานคนนี้?")) return;
    await adminFetch(`${API_URL}/employees/${id}`, { method: 'DELETE' });
    fetchEmployees();
    onUpdate();
  };

  useEffect(() => { fetchEmployees(); }, []);

  return (
    <div className="space-y-8">
      <div className="flex justify-end px-2">
        <button onClick={() => setShowModal(true)} className="px-8 py-4 bg-zinc-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-black transition-all shadow-xl shadow-black/10 flex items-center gap-2">
          <UserPlus size={16} /> Register New Member
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {employees.map((emp) => (
          <div key={emp.id} className="bg-white p-6 rounded-[2rem] border border-zinc-200/60 shadow-sm hover:border-zinc-300 transition-all group flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-zinc-50 rounded-2xl flex items-center justify-center font-bold text-zinc-400 border border-zinc-100 group-hover:text-indigo-600 transition-colors">{emp.name.charAt(0)}</div>
              <div>
                <div className="font-bold text-zinc-800 text-base">{emp.name}</div>
                <div className="text-[10px] font-mono text-zinc-400 uppercase">{emp.id}</div>
                <div className="text-[9px] text-zinc-400 mt-0.5">{emp.face_count ?? 1} รูป</div>
                {Object.keys(emp.schedule || {}).length > 0 && (
                  <div className="text-[9px] font-bold text-indigo-500 mt-0.5">
                    ⏰ เวลาเฉพาะ {Object.keys(emp.schedule).length} วัน
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => setAddFacesEmp(emp)} className="p-2 text-zinc-300 hover:text-emerald-500 transition-colors" title="เพิ่มรูปใบหน้า">
                <Camera size={16} />
              </button>
              <button onClick={() => setScheduleEmp(emp)} className="p-2 text-zinc-300 hover:text-indigo-500 transition-colors">
                <Clock size={16} />
              </button>
              <button onClick={() => handleDelete(emp.id)} className="p-2 text-zinc-200 hover:text-rose-500 transition-colors">
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {showModal && <RegistrationModal onClose={() => { setShowModal(false); fetchEmployees(); onUpdate(); }} />}
        {scheduleEmp && <ScheduleModal emp={scheduleEmp} onClose={() => { setScheduleEmp(null); fetchEmployees(); }} />}
        {addFacesEmp && <AddFacesModal emp={addFacesEmp} onClose={() => { setAddFacesEmp(null); fetchEmployees(); }} />}
      </AnimatePresence>
    </div>
  );
}

const DAYS_TH = [
  { key: '0', short: 'จ', label: 'จันทร์' },
  { key: '1', short: 'อ', label: 'อังคาร' },
  { key: '2', short: 'พ', label: 'พุธ' },
  { key: '3', short: 'พฤ', label: 'พฤหัส' },
  { key: '4', short: 'ศ', label: 'ศุกร์' },
  { key: '5', short: 'ส', label: 'เสาร์' },
  { key: '6', short: 'อา', label: 'อาทิตย์' },
];
type DaySched = { checkin_before: string; late_cutoff: string; checkout_after: string };

function ScheduleModal({ emp, onClose }: { emp: any; onClose: () => void }) {
  const [days, setDays] = useState<Record<string, DaySched | null>>(() => {
    const init: Record<string, DaySched | null> = {};
    for (const d of DAYS_TH) init[d.key] = emp.schedule?.[d.key] ?? null;
    return init;
  });
  const [saving, setSaving] = useState(false);

  const toggle = (key: string) =>
    setDays(d => ({ ...d, [key]: d[key] ? null : { checkin_before: "08:00:00", late_cutoff: "09:00:00", checkout_after: "17:00:00" } }));

  const update = (key: string, field: keyof DaySched, val: string) =>
    setDays(d => ({ ...d, [key]: { ...d[key]!, [field]: val } }));

  const save = async () => {
    setSaving(true);
    const active: Record<string, DaySched> = {};
    for (const [k, v] of Object.entries(days)) if (v) active[k] = v;
    if (Object.keys(active).length === 0) {
      await adminFetch(`${API_URL}/employees/${emp.id}/schedule`, { method: 'DELETE' });
    } else {
      await adminFetch(`${API_URL}/employees/${emp.id}/schedule`, {
        method: 'PUT', body: JSON.stringify({ days: active }),
      });
    }
    setSaving(false);
    onClose();
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-md">
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }}
        className="bg-white w-full max-w-lg rounded-[2.5rem] shadow-2xl overflow-hidden border border-zinc-200/50">

        <div className="p-8 border-b border-zinc-100 flex justify-between items-center bg-zinc-50/50">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.3em]">ตารางเวลาเฉพาะ</h3>
            <p className="text-xs text-zinc-400 mt-0.5">{emp.name} · วันที่ไม่ได้เปิดจะใช้เวลากลาง</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-zinc-100 rounded-full text-zinc-400"><X size={18} /></button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh] space-y-1.5">
          <div className="grid grid-cols-[88px_1fr_1fr_1fr] gap-2 px-3 pb-1">
            <div />
            {['เข้าปกติก่อน', 'สายหลัง', 'ออกงานหลัง'].map(h => (
              <div key={h} className="text-[9px] font-black uppercase tracking-widest text-zinc-400 text-center">{h}</div>
            ))}
          </div>

          {DAYS_TH.map(({ key, short, label }) => {
            const s = days[key];
            const on = s !== null;
            return (
              <div key={key}
                className={`grid grid-cols-[88px_1fr_1fr_1fr] gap-2 items-center px-3 py-2.5 rounded-2xl transition-colors ${on ? 'bg-indigo-50' : 'bg-zinc-50'}`}>
                <button onClick={() => toggle(key)} className={`flex items-center gap-2 text-left transition-colors ${on ? 'text-indigo-700' : 'text-zinc-400'}`}>
                  <div className={`w-8 h-5 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ${on ? 'bg-indigo-500' : 'bg-zinc-200'}`}>
                    <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-3' : ''}`} />
                  </div>
                  <span className="text-xs font-bold">{short} <span className="text-zinc-500 font-normal">{label}</span></span>
                </button>
                {on ? (
                  ['checkin_before', 'late_cutoff', 'checkout_after'].map(f => (
                    <div key={f} className="flex justify-center">
                      <input type="time" step="1" value={s![f as keyof DaySched]}
                        onChange={e => update(key, f as keyof DaySched, e.target.value)}
                        className="bg-white border border-indigo-200 rounded-lg px-1 py-1.5 text-center font-mono text-sm outline-none focus:border-indigo-500 transition-all" />
                    </div>
                  ))
                ) : (
                  <div className="col-span-3 text-center text-[10px] text-zinc-400">ใช้เวลากลาง</div>
                )}
              </div>
            );
          })}

          <div className="mt-3 p-3 bg-amber-50 rounded-2xl text-[10px] text-amber-700 leading-relaxed">
            <b>ตัวอย่าง</b> — เข้า 08:00 วันจันทร์, เข้า 11:00 วันศุกร์:<br />
            วัน จ → เข้า <b>08:00</b>, สาย <b>09:00</b>, ออก <b>17:00</b> &nbsp;·&nbsp; วัน ศ → เข้า <b>11:00</b>, สาย <b>12:00</b>, ออก <b>21:00</b>
          </div>
        </div>

        <div className="p-6 border-t border-zinc-100">
          <button onClick={save} disabled={saving}
            className="w-full py-4 bg-black text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-zinc-800 disabled:bg-zinc-200 transition-all flex items-center justify-center gap-2">
            {saving ? <Loader2 className="animate-spin" size={16} /> : 'บันทึก'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function RegistrationModal({ onClose }: { onClose: () => void }) {
  const webcamRef = useRef<Webcam>(null);
  const [step, setStep] = useState(1);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [capturedImages, setCapturedImages] = useState<string[]>([]);
  const [isRegistering, setIsRegistering] = useState(false);

  const takePhoto = () => {
    if (webcamRef.current) {
      const image = webcamRef.current.getScreenshot();
      if (image) setCapturedImages(prev => [...prev, image].slice(-10));
    }
  };

  const handleRegister = async () => {
    setIsRegistering(true);
    try {
      const res = await adminFetch(`${API_URL}/register`, {
        method: 'POST',
        body: JSON.stringify({ emp_id: id, name, email, phone, images: capturedImages }),
      });
      if (res.ok) onClose();
      else alert("Error: " + (await res.text()));
    } catch (err) { console.error(err); }
    finally { setIsRegistering(false); }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-md text-black">
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col border border-zinc-200/50">
        <div className="p-10 border-b border-zinc-100 flex justify-between items-center bg-zinc-50/50">
          <h3 className="text-sm font-black uppercase tracking-[0.3em]">New Enrollment</h3>
          <button onClick={onClose} className="p-2 hover:bg-zinc-100 rounded-full text-zinc-400 transition-colors"><X size={20} /></button>
        </div>

        <div className="p-10 space-y-8 overflow-y-auto max-h-[75vh]">
          {step === 1 ? (
            <div className="space-y-10">
              <div className="space-y-8">
                {[
                  { label: "ID", value: id, onChange: setId, placeholder: "EMP000" },
                  { label: "Full Name", value: name, onChange: setName, placeholder: "NAME SURNAME" },
                  { label: "Email", value: email, onChange: setEmail, placeholder: "name@company.com" },
                  { label: "Phone", value: phone, onChange: setPhone, placeholder: "0812345678" },
                ].map(f => (
                  <div key={f.label} className="space-y-2 border-b border-zinc-100 pb-2">
                    <label className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">{f.label}</label>
                    <input value={f.value} onChange={e => f.onChange(e.target.value)} placeholder={f.placeholder} className="w-full bg-transparent text-lg font-light outline-none" />
                  </div>
                ))}
              </div>
              <button disabled={!id || !name} onClick={() => setStep(2)} className="w-full py-5 rounded-2xl font-black uppercase tracking-widest bg-black text-white hover:bg-zinc-800 transition-all disabled:bg-zinc-100">
                Continue →
              </button>
            </div>
          ) : (
            <div className="space-y-8">
              <div className="relative aspect-[4/3] bg-zinc-50 rounded-[2rem] overflow-hidden border border-zinc-100">
                <Webcam ref={webcamRef} screenshotFormat="image/jpeg" className="w-full h-full object-cover scale-x-[-1]"
                  videoConstraints={{ facingMode: 'user', aspectRatio: 4 / 3 }} />
              </div>
              <div className="grid grid-cols-5 gap-3">
                {capturedImages.map((img, i) => (
                  <div key={i} className="aspect-square rounded-xl overflow-hidden border border-zinc-100 shadow-sm">
                    <img src={img} className="w-full h-full object-cover" />
                  </div>
                ))}
                {capturedImages.length < 10 && (
                  <button onClick={takePhoto} className="aspect-square rounded-xl border-2 border-dashed border-zinc-200 flex flex-col items-center justify-center text-zinc-300 hover:text-black hover:border-black transition-all bg-zinc-50/50">
                    <Camera size={20} />
                    <span className="text-[8px] font-bold mt-1">{capturedImages.length}/10</span>
                  </button>
                )}
              </div>
              <div className="flex gap-4">
                <button onClick={() => setStep(1)} className="flex-1 py-4 font-bold text-zinc-400 hover:text-zinc-800">Back</button>
                <button disabled={capturedImages.length < 5 || isRegistering} onClick={handleRegister}
                  className="flex-[2] py-5 rounded-2xl font-black uppercase tracking-widest bg-black text-white shadow-xl hover:bg-zinc-800 transition-all disabled:bg-zinc-200">
                  {isRegistering ? <Loader2 className="animate-spin mx-auto" /> : 'Register'}
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function AddFacesModal({ emp, onClose }: { emp: any; onClose: () => void }) {
  const webcamRef = useRef<Webcam>(null);
  const [capturedImages, setCapturedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const takePhoto = () => {
    const image = webcamRef.current?.getScreenshot();
    if (image) setCapturedImages(prev => [...prev, image].slice(-10));
  };

  const handleSave = async () => {
    if (capturedImages.length === 0) return;
    setLoading(true); setMsg('');
    try {
      const res = await adminFetch(`${API_URL}/employees/${emp.id}/faces`, {
        method: 'POST',
        body: JSON.stringify({ images: capturedImages }),
      });
      const data = await res.json();
      if (res.ok) { setMsg(`✓ ${data.message}`); setTimeout(onClose, 1500); }
      else setMsg(`✗ ${data.detail}`);
    } catch { setMsg('✗ เชื่อมต่อ server ไม่ได้'); }
    finally { setLoading(false); }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-md text-black">
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }}
        className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col border border-zinc-200/50">

        <div className="p-8 border-b border-zinc-100 flex justify-between items-center bg-zinc-50/50">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.3em]">เพิ่มรูปใบหน้า</h3>
            <p className="text-xs text-zinc-400 mt-0.5">{emp.name} · มี {emp.face_count ?? 1} รูปในระบบ</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-zinc-100 rounded-full text-zinc-400 transition-colors"><X size={20} /></button>
        </div>

        <div className="p-8 space-y-6 overflow-y-auto max-h-[75vh]">
          <div className="relative aspect-[4/3] bg-zinc-50 rounded-[2rem] overflow-hidden border border-zinc-100">
            <Webcam ref={webcamRef} screenshotFormat="image/jpeg" className="w-full h-full object-cover scale-x-[-1]"
              videoConstraints={{ facingMode: 'user', aspectRatio: 4 / 3 }} />
          </div>
          <div className="grid grid-cols-5 gap-3">
            {capturedImages.map((img, i) => (
              <div key={i} className="aspect-square rounded-xl overflow-hidden border border-zinc-100 shadow-sm">
                <img src={img} className="w-full h-full object-cover" />
              </div>
            ))}
            {capturedImages.length < 10 && (
              <button onClick={takePhoto} className="aspect-square rounded-xl border-2 border-dashed border-zinc-200 flex flex-col items-center justify-center text-zinc-300 hover:text-black hover:border-black transition-all bg-zinc-50/50">
                <Camera size={20} />
                <span className="text-[8px] font-bold mt-1">{capturedImages.length}/10</span>
              </button>
            )}
          </div>
          {msg && <div className={`rounded-2xl px-5 py-4 text-sm font-bold ${msg.startsWith('✓') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{msg}</div>}
          <button disabled={capturedImages.length === 0 || loading} onClick={handleSave}
            className="w-full py-5 rounded-2xl font-black uppercase tracking-widest bg-black text-white hover:bg-zinc-800 disabled:bg-zinc-200 transition-all flex items-center justify-center gap-2">
            {loading ? <Loader2 className="animate-spin" size={16} /> : `เพิ่ม ${capturedImages.length} รูป`}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default App;
