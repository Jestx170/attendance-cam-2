import xmlrpc.client
import logging
import json
import os
from datetime import datetime, timezone

log = logging.getLogger(__name__)

CONFIG_FILE = "config.json"


def _load_odoo_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                return json.load(f).get("odoo", {})
        except Exception:
            pass
    return {}


class OdooAttendance:
    def __init__(self):
        self._uid = None
        self._models = None
        cfg = _load_odoo_config()
        self.url      = cfg.get("url", "")
        self.db       = cfg.get("db", "")
        self.username = cfg.get("username", "")
        self.api_key  = cfg.get("api_key", "")
        if self.url and self.db and self.username and self.api_key:
            self._connect()

    def _connect(self) -> bool:
        try:
            self._uid = None
            self._models = None
            common = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/common")
            self._uid = common.authenticate(self.db, self.username, self.api_key, {})
            if not self._uid:
                log.error("Odoo auth failed — check credentials")
                self._uid = None
                self._models = None
                return False
            self._models = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/object")
            log.info(f"Odoo connected (uid={self._uid})")
            return True
        except Exception as e:
            log.error(f"Odoo connection error: {e} | URL={self.url} DB={self.db}")
            self._uid = None
            self._models = None
            return False

    @property
    def is_connected(self) -> bool:
        return self._uid is not None

    def reconnect(self) -> bool:
        cfg = _load_odoo_config()
        self.url      = cfg.get("url", "")
        self.db       = cfg.get("db", "")
        self.username = cfg.get("username", "")
        self.api_key  = cfg.get("api_key", "")
        return self._connect()

    def _get_employee_id(self, name: str) -> int | None:
        try:
            results = self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.employee", "search_read",
                [[["name", "=", name]]],
                {"fields": ["id", "name"], "limit": 1},
            )
            return results[0]["id"] if results else None
        except Exception as e:
            log.error(f"Odoo get_employee error: {e}")
            return None

    def _to_utc(self, dt: datetime) -> str:
        if dt.tzinfo is None:
            # Assume Asia/Bangkok (UTC+7)
            from datetime import timedelta
            dt = dt.replace(tzinfo=timezone(timedelta(hours=7)))
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    def create_employee(self, name: str, email: str = "", phone: str = "") -> int | None:
        """สร้าง hr.employee ใน Odoo และคืน odoo employee id"""
        if not self.is_connected:
            return None
        try:
            existing = self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.employee", "search_read",
                [[["name", "=", name]]],
                {"fields": ["id"], "limit": 1},
            )
            if existing:
                log.info(f"Odoo employee already exists: {name} (id={existing[0]['id']})")
                return existing[0]["id"]

            vals: dict = {"name": name, "employee_type": "employee"}
            if email:
                vals["work_email"] = email
            if phone:
                vals["work_phone"] = phone

            odoo_id = self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.employee", "create",
                [vals],
            )
            log.info(f"Odoo employee created: {name} (id={odoo_id})")
            return odoo_id
        except Exception as e:
            log.error(f"Odoo create_employee error: {e}")
            return None

    def push_checkin(self, name: str, dt: datetime) -> bool:
        if not self.is_connected:
            return False
        emp_id = self._get_employee_id(name)
        if not emp_id:
            log.warning(f"Odoo: employee '{name}' not found")
            return False
        try:
            self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.attendance", "create",
                [{"employee_id": emp_id, "check_in": self._to_utc(dt)}],
            )
            log.info(f"Odoo check-in pushed: {name}")
            return True
        except Exception as e:
            log.error(f"Odoo check-in error: {e}")
            return False

    def push_checkout(self, name: str, dt: datetime) -> bool:
        if not self.is_connected:
            return False
        emp_id = self._get_employee_id(name)
        if not emp_id:
            log.warning(f"Odoo: employee '{name}' not found")
            return False
        try:
            # Find the open attendance record (check_out = False)
            open_records = self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.attendance", "search_read",
                [[["employee_id", "=", emp_id], ["check_out", "=", False]]],
                {"fields": ["id"], "order": "check_in desc", "limit": 1},
            )
            utc_str = self._to_utc(dt)
            if open_records:
                self._models.execute_kw(
                    self.db, self._uid, self.api_key,
                    "hr.attendance", "write",
                    [[open_records[0]["id"]], {"check_out": utc_str}],
                )
            else:
                log.warning(f"Odoo: no open attendance record for '{name}' — skipping check-out")
                return False
            log.info(f"Odoo check-out pushed: {name}")
            return True
        except Exception as e:
            log.error(f"Odoo check-out error: {e}")
            return False

    def fetch_attendance(self, date_from: str, date_to: str) -> list[dict]:
        """ดึง hr.attendance จาก Odoo ในช่วงวันที่ (YYYY-MM-DD)
        คืน list ของ {id, employee_name, check_in, check_out} โดย time เป็น HH:MM:SS (Bangkok)"""
        if not self.is_connected:
            return []
        try:
            from datetime import timedelta
            BKK = timezone(timedelta(hours=7))
            since = f"{date_from} 00:00:00"
            until = f"{date_to} 23:59:59"
            # แปลง Bangkok → UTC สำหรับ filter ใน Odoo
            since_utc = datetime.strptime(since, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BKK).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            until_utc = datetime.strptime(until, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BKK).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            records = self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.attendance", "search_read",
                [[["check_in", ">=", since_utc], ["check_in", "<=", until_utc]]],
                {"fields": ["id", "employee_id", "check_in", "check_out"]},
            )
            result = []
            for r in records:
                emp_name = r["employee_id"][1] if r["employee_id"] else None
                if not emp_name:
                    continue
                ci_utc = datetime.strptime(r["check_in"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                ci_bkk = ci_utc.astimezone(BKK)
                co_bkk_str = None
                if r["check_out"]:
                    co_utc = datetime.strptime(r["check_out"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                    co_bkk_str = co_utc.astimezone(BKK).strftime("%H:%M:%S")
                result.append({
                    "id": r["id"],
                    "employee_name": emp_name,
                    "check_in": ci_bkk.strftime("%H:%M:%S"),
                    "check_in_date": ci_bkk.strftime("%Y-%m-%d"),
                    "check_out": co_bkk_str,
                    "check_out_date": co_utc.astimezone(BKK).strftime("%Y-%m-%d") if r["check_out"] else None,
                })
            return result
        except Exception as e:
            log.error(f"Odoo fetch_attendance error: {e}")
            return []

    def archive_employee(self, name: str) -> bool:
        if not self.is_connected:
            return False
        emp_id = self._get_employee_id(name)
        if not emp_id:
            log.warning(f"Odoo: employee '{name}' not found for archive")
            return False
        try:
            self._models.execute_kw(
                self.db, self._uid, self.api_key,
                "hr.employee", "write",
                [[emp_id], {"active": False}],
            )
            log.info(f"Odoo employee archived: {name}")
            return True
        except Exception as e:
            log.error(f"Odoo archive_employee error: {e}")
            return False


# Singleton — imported by main_api.py
odoo = OdooAttendance()
