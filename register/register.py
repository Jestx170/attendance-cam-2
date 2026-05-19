from deepface import DeepFace
import json, os

DB_FILE = "embeddings.json"

def register(emp_id, name, img_folder):
    # โหลด database เดิม (ถ้ามี)
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r") as f:
            db = json.load(f)
    else:
        db = {}

    # สกัด embedding จากทุกรูป
    embeddings = []
    for filename in os.listdir(img_folder):
        if not filename.lower().endswith((".jpg",".jpeg",".png")):
            continue
        img_path = os.path.join(img_folder, filename)
        try:
            result = DeepFace.represent(
                img_path=img_path,
                model_name="ArcFace",
                enforce_detection=False
            )
            embeddings.append(result[0]["embedding"])
            print(f"  ประมวลผล {filename} สำเร็จ")
        except Exception as e:
            print(f"  ข้าม {filename}: {e}")

    if not embeddings:
        print(f"ไม่พบรูปใน {img_folder}")
        return

    # เฉลี่ย embedding ทุกรูป
    avg = [sum(x) / len(x) for x in zip(*embeddings)]
    db[emp_id] = {"name": name, "embedding": avg}

    # บันทึกกลับ
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    print(f"ลงทะเบียน '{name}' สำเร็จ ({len(embeddings)} รูป)")


# --- แก้ตรงนี้ให้ตรงกับพนักงานของคุณ ---
register("emp001", "Poramin Sopakham",   "/Users/jes/Documents/aacc/jes")
register("emp002", "pongsathon pookduang",   "/Users/jes/Documents/aacc/oug")
register("emp003", "Butsaba Chanchomphu",   "/Users/jes/Documents/aacc/fon")
register("emp004", "jirapinya hanchanachai",   "/Users/jes/Documents/aacc/view")
register("emp005", "Rangsiman phumala",   "/Users/jes/Documents/aacc/dum")
register("emp006", "Thidarat Siboonrot",   "/Users/jes/Documents/aacc/bow")
register("emp007", "Naphatson Auppatham",   "/Users/jes/Documents/aacc/plelng")
register("emp008", "Natnicha Aintarathat",   "/Users/jes/Documents/aacc/nut")
register("emp009", "Arisa Wongpanya",   "/Users/jes/Documents/aacc/mint")


# เพิ่มต่อได้เรื่อยๆ
register("EMP011", "Keeratipong Baobaongern", "D:/attendance cam/registered_faces/EMP011_Keeratipong_Baobaongern")
register("1111", "phutthanet", "D:/attendance cam/registered_faces/1111_phutthanet")
register("1212", "Gerad Way", "D:/attendance cam/registered_faces/1212_Gerad_Way")
register("EPM000", "jj", "/Users/jes/Downloads/attendance cam 2/registered_faces/EPM000_jj")
register("EMP000", "Poramin Sopakham", "/Users/jes/Downloads/attendance cam 2/registered_faces/EMP000_Poramin_Sopakham")
register("EMP000", "Poramin Sopakham", "/Users/jes/Downloads/attendance cam 2/registered_faces/EMP000_Poramin_Sopakham")
register("EMP000", "Poramin Sopakham", "/Users/jes/Downloads/attendance cam 2/registered_faces/EMP000_Poramin_Sopakham")
register("49038", "hf9ig", "/Users/jes/Downloads/attendance cam 2/registered_faces/49038_hf9ig")
register("1", "dsf", "/Users/jes/Downloads/attendance cam 2/registered_faces/1_dsf")
register("EMP000", "Poramin Sopakham", "/Users/jes/Downloads/attendance cam 2/registered_faces/EMP000_Poramin_Sopakham")
register("54", "Poramin Sopakham", "/Users/jes/Downloads/attendance cam 2/registered_faces/54_Poramin_Sopakham")
register("23", "Poramin Sopakham", "/Users/jes/Downloads/attendance cam 2/registered_faces/23_Poramin_Sopakham")