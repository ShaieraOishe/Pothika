#!/usr/bin/env python3
"""
Generate comprehensive mock data for Dhaka Safe Routes.
Covers all major areas of Dhaka Metropolitan Area with realistic
risk scoring based on news reports.
"""
import json
import math
import os
import random
from datetime import date

random.seed(42)

# ── Bounding box ───────────────────────────────────────────────
WEST, SOUTH, EAST, NORTH = 90.33, 23.70, 90.45, 23.83

# ── Risk zones with specific safety advisories for women ──────
# (center_lon, center_lat, radius_deg, name, name_bn, risk_level, caution_bn, tip_bn)
# risk_level: 0=Safe Green, 1=Moderate-Low, 2=Moderate Caution, 3=Elevated Alert, 4=High Caution Alert
RISK_ZONES = [
    # High Caution Zones (লাল - উচ্চ সতর্কতা এলাকা)
    (90.3900, 23.7230, 0.015, "Old Dhaka Interior", "পুরান ঢাকা বাবুবাজার ও নদীর তীর", 4,
     "সরু গলি, কম আলোকসজ্জা ও রাতে নির্জন এলাকা। ছিনতাই ও হয়রানির ঝুঁকি বেশি।",
     "সন্ধ্যা ৭টার পর একা হাঁটা এড়িয়ে চলুন। রিকশা বা সিএনজি ব্যবহার করুন। নিকটতম কোতোয়ালী থানা ৩৫০ মি."),
    (90.3830, 23.7280, 0.012, "Lalbagh Inside Lanes", "লালবাগ কেল্লার পেছনের গলি", 4,
     "অন্ধকার গলি ও অপ্রশস্ত রাস্তা। রাতে পর্যাপ্ত লোকসমাগম থাকে না।",
     "মেইন লালবাগ রোড ও চকবাজার রোড দিয়ে চলুন। বিপদে সরাসরি লালবাগ থানায় যোগাযোগ করুন।"),
    (90.3650, 23.7300, 0.015, "Kamrangirchar", "কামরাঙ্গীরচর বেরিবাঁধ এলাকা", 4,
     "রাত নামলেই এলাকা নির্জন হয়ে পড়ে এবং আলোর ঘাটতি রয়েছে।",
     "বেরিবাঁধ দিয়ে একা হাঁটা অনুচিত। পরিচিত যানবাহনে দ্রুত প্রধান সড়কে পৌঁছান।"),
    (90.4100, 23.7100, 0.015, "Jatrabari Crossing", "যাত্রাবাড়ী বাস টার্মিনাল মোড়", 3,
     "অতিরিক্ত ভিড়, বিশৃঙ্খল পরিবেশ এবং রাতের দিকে অন্ধকারের ঝুঁকি।",
     "উজ্জ্বল আলোকিত দোকানের পাশ দিয়ে হাঁটুন। ব্যাগ ও মোবাইল সাবধানে রাখুন।"),
    (90.3950, 23.7080, 0.012, "Sadarghat Riverfront", "সদরঘাট লঞ্চ টার্মিনাল রোড", 3,
     "সন্ধ্যার পর নদীর ঘাট এলাকা নির্জন ও অনিরাপদ হয়ে ওঠে।",
     "টার্মিনাল রোডের প্রধান দোকানপাটের পথ ব্যবহার করুন। একা নির্জন পন্টুনে যাবেন না।"),
    (90.4100, 23.7650, 0.012, "Hatirjheel Walkway (Night)", "হাতিরঝিল পদচারী পথ (রাতের বেলা)", 3,
     "দিনের বেলা চমৎকার হলেও রাত ৯টার পর অনেক হাঁটার পথ নির্জন ও বিচ্ছিন্ন থাকে।",
     "রাতে একা ব্রিজের নিচের নির্জন ওয়াকওয়েতে না হেঁটে মূল সড়কের রিকশা বা গাড়ি ব্যবহার করুন।"),

    # Moderate Caution Zones (হলুদ - মাঝারি সতর্কতা এলাকা)
    (90.3650, 23.7950, 0.018, "Mirpur Interior", "মিরপুর কলোনি ও সংযোগ সড়ক", 2,
     "প্রধান সড়ক নিরাপদ হলেও ভেতরের শাখা রোডে আলোর ঘাটতি থাকতে পারে।",
     "মেট্রোরেল করিডোর ও রোকেয়া সরণির আলোকিত অংশ দিয়ে চলুন।"),
    (90.3550, 23.8050, 0.015, "Pallabi Extended", "পল্লবী বাউনিয়া বাঁধ এলাকা", 2,
     "খোলা মাঠ ও নির্মাণাধীন এলাকার পাশে রাতে একা না হাঁটাই ভালো।",
     "পল্লবী প্রধান এভিনিউ দিয়ে চলাচল করুন।"),
    (90.3600, 23.7600, 0.015, "Mohammadpur Geneva Camp Area", "মোহাম্মদপুর টাউন হল সংলগ্ন গলি", 2,
     "ভিড়বহুল বাজার এলাকার পেছনের গলিতে নজরদারি কম।",
     "আসাদ এভিনিউ ও তাজমহল রোডের প্রধান আলোযুক্ত অংশ ব্যবহার করুন।"),
    (90.4250, 23.7450, 0.012, "Khilgaon Rail Gate Area", "খিলগাঁও রেলগেট সংলগ্ন পথ", 2,
     "রেললাইনের পাশের পথ রাতে অন্ধকারাচ্ছন্ন থাকে।",
     "ফ্লাইওভারের নিচের সার্ভিস রোড এড়িয়ে ফ্লাইওভারের প্রধান সড়ক ব্যবহার করুন।"),
    (90.4300, 23.7600, 0.012, "Rampura Canal Side", "রামপুরা খালের পেছনের গলি", 2,
     "খালের পাশের গলিগুলোতে পর্যাপ্ত লাইটিং নেই।",
     "ডিআইটি প্রধান রোড ব্যবহার করুন।"),
    (90.4300, 23.7800, 0.012, "Badda Link Roads", "বাড্ডা লিংক রোড ও বৈশাখী স্মরণী", 2,
     "অপেক্ষাকৃত সরু রাস্তা ও জনসমাগম কমে যাওয়ার প্রবণতা।",
     "প্রগতি সরণি ধরে চলুন যেখানে বাস ও রিকশা সহজে পাওয়া যায়।"),
    (90.4100, 23.7300, 0.012, "Motijheel C/A (Night)", "মতিঝিল ব্যাংক এলাকা (অফিস সময়ের পর)", 2,
     "সন্ধ্যা ৭টার পর বাণিজ্যিক এলাকা সম্পূর্ণ জনমানবহীন হয়ে যায়।",
     "শাপলা চত্বরের প্রধান রুট ব্যবহার করুন, নির্জন ব্যাক-লেন পরিহার করুন।"),

    # Safe Green Zones & Corridors (সবুজ - নিরাপদ এলাকা ও করিডোর)
    (90.3750, 23.7470, 0.016, "Dhanmondi Safe Corridor", "ধানমন্ডি ২৭ ও সাতমসজিদ রোড করিডোর", 0,
     "উচ্চ নিরাপত্তা জোন: ২৪ ঘণ্টা দোকানপাট, ক্যাফে ও পুলিশ বক্সের সার্বক্ষণিক নজরদারি।",
     "নারীদের চলাচলের জন্য ঢাকার অন্যতম নিরাপদ অঞ্চল।"),
    (90.4150, 23.7900, 0.016, "Gulshan Avenue Corridor", "গুলশান ১ ও ২ এভিনিউ", 0,
     "সর্বাধিক সিসিটিভি নজরদারি, ডিপ্লোম্যাটিক সিকিউরিটি ও উজ্জ্বল সড়ক বাতি।",
     "রাতের বেলা হাঁটা ও যাতায়াতের জন্য অত্যন্ত নিরাপদ।"),
    (90.4050, 23.7950, 0.014, "Banani 11 Corridor", "বনানী ১১ নম্বর কামাল আতাতুর্ক এভিনিউ", 0,
     "ব্যস্ত বাণিজ্যিক এলাকা, পর্যাপ্ত ট্রাফিক ও নারী পথচারীদের অবাধ চলাচল।",
     "নিরাপদ হাঁটার পরিবেশ ও রিকশা প্রাপ্তি নিশ্চিত।"),
    (90.3960, 23.7380, 0.012, "Shahbag - TSC Corridor", "শাহবাগ, টিএসসি ও ঢাকা বিশ্ববিদ্যালয় এলাকা", 0,
     "সার্বক্ষণিক ছাত্র-জনতার উপস্থিতি, বিশ্ববিদ্যালয় নিরাপত্তা ও সুপ্রশস্ত আলোকিত রোড।",
     "রাত ১০টা পর্যন্ত নিরাপদ ও স্বাচ্ছন্দ্যময় পদচারণা।"),
    (90.4000, 23.7400, 0.012, "Ramna Park & VIP Road", "রমনা পার্ক ও হেয়ার রোড", 0,
     "হাই-সিকিউরিটি জোন ও পরিষ্কার দৃশ্যমান ফুটপাত।",
     "সকাল ও সন্ধ্যায় নিরাপদে হাঁটার উপযোগী।"),
    (90.3900, 23.7560, 0.012, "Farmgate Commercial Hub", "ফার্মগেট ও কারওয়ান বাজার মেট্রো জংশন", 1,
     "মেট্রোরেল স্টেশন, ব্যস্ত ফুটব্রিজ ও পুলিশ সহায়তা কেন্দ্র।",
     "মেট্রোরেলের নিচের আলোকিত ফুটপাত ব্যবহার করুন।"),
    (90.4250, 23.8050, 0.016, "Bashundhara R/A", "বসুন্ধরা আবাসিক এলাকা প্রধান এভিনিউ", 1,
     "গেট সিকিউরিটি, প্রাইভেট গার্ড ও নিয়ন্ত্রিত প্রবেশপথ।",
     "মেইন এভিনিউগুলো সম্পূর্ণ আলোকিত ও নিরাপদ।"),
    (90.4000, 23.8200, 0.020, "Uttara Model Town", "উত্তরা ৩, ৭ ও ১১ নম্বর সেক্টর", 1,
     "পরিকল্পিত আবাসিক ব্লক, সিসিটিভি ও মেট্রো সংযোগ।",
     "যেকোনো সেক্টরের প্রধান এভিনিউ রাতেও নিরাপদ।"),
]

# ── Metro Line 6 Stations (ঢাকার মেট্রোরেল স্টেশন - নিরাপদ ট্রানজিট পয়েন্ট) ──
METRO_STATIONS = [
    ("Uttara North", "উত্তরা উত্তর (দিয়াবাড়ী)", 90.3950, 23.8320),
    ("Uttara Center", "উত্তরা সেন্টার", 90.3950, 23.8240),
    ("Uttara South", "উত্তরা দক্ষিণ", 90.3900, 23.8160),
    ("Pallabi", "পল্লবী", 90.3640, 23.8180),
    ("Mirpur 11", "মিরপুর ১১", 90.3650, 23.8090),
    ("Mirpur 10", "মিরপুর ১০ মোড়", 90.3680, 23.8050),
    ("Kazipara", "কাজীপাড়া", 90.3720, 23.7940),
    ("Shewrapara", "শেওড়াপাড়া", 90.3740, 23.7880),
    ("Agargaon", "আগারগাঁও", 90.3780, 23.7760),
    ("Bijoy Sarani", "বিজয় সরণি", 90.3870, 23.7660),
    ("Farmgate", "ফার্মগেট", 90.3900, 23.7570),
    ("Karwan Bazar", "কারওয়ান বাজার", 90.3940, 23.7500),
    ("Shahbag", "শাহবাগ", 90.3950, 23.7380),
    ("Dhaka University", "ঢাকা বিশ্ববিদ্যালয় (টিএসসি)", 90.3960, 23.7310),
    ("Secretariat", "বাংলাদেশ সচিবালয়", 90.4040, 23.7290),
    ("Motijheel", "মতিঝিল", 90.4150, 23.7280),
]

# Risk mapping:  level -> (lighting_risk, road_risk, activity_risk)
RISK_MAP = {
    0: (0.15, 0.20, 0.20),  # low risk - well lit, good roads, active area
    1: (0.30, 0.30, 0.35),  # moderate-low
    2: (0.45, 0.40, 0.50),  # moderate
    3: (0.60, 0.50, 0.65),  # moderate-high
    4: (0.75, 0.60, 0.80),  # high risk
}

# ── Named roads with approximate paths ────────────────────────
NAMED_ROADS = [
    # (name, start_lon, start_lat, end_lon, end_lat, hw_type)
    ("Airport Road",         90.4000, 23.7750, 90.4000, 23.8250, "primary"),
    ("Mirpur Road",          90.3700, 23.7400, 90.3700, 23.8000, "primary"),
    ("Satmasjid Road",       90.3650, 23.7400, 90.3800, 23.7400, "secondary"),
    ("Dhanmondi Road 27",    90.3700, 23.7450, 90.3800, 23.7500, "tertiary"),
    ("Gulshan Avenue",       90.4050, 23.7850, 90.4200, 23.7900, "primary"),
    ("Banani Road 11",       90.4000, 23.7900, 90.4100, 23.7950, "tertiary"),
    ("Shahbag Road",         90.3930, 23.7350, 90.3980, 23.7400, "secondary"),
    ("Elephant Road",        90.3870, 23.7360, 90.3870, 23.7480, "secondary"),
    ("Kazi Nazrul Islam Ave",90.3900, 23.7500, 90.3900, 23.7700, "primary"),
    ("Rokeya Sarani",        90.3650, 23.7600, 90.3650, 23.8100, "primary"),
    ("Pragati Sarani",       90.4150, 23.7800, 90.4350, 23.8100, "primary"),
    ("Mohakhali Flyover",    90.4000, 23.7750, 90.4100, 23.7800, "trunk"),
    ("Manik Mia Avenue",     90.3800, 23.7600, 90.3900, 23.7600, "primary"),
    ("Bijoy Sarani",         90.3900, 23.7600, 90.4050, 23.7600, "primary"),
    ("Shaheed Tajuddin Ahmed Sarani", 90.4000, 23.7600, 90.4050, 23.7700, "primary"),
    ("Minto Road",           90.4050, 23.7350, 90.4050, 23.7420, "secondary"),
    ("Topkhana Road",        90.4080, 23.7250, 90.4100, 23.7350, "secondary"),
    ("Nazimuddin Road",      90.3850, 23.7250, 90.3900, 23.7250, "secondary"),
    ("Nawabpur Road",        90.4050, 23.7100, 90.4080, 23.7250, "secondary"),
    ("Islampur Road",        90.3950, 23.7150, 90.4000, 23.7200, "tertiary"),
    ("Bangshal Road",        90.4000, 23.7200, 90.4050, 23.7200, "tertiary"),
    ("Hatirjheel Link Road", 90.4000, 23.7600, 90.4200, 23.7700, "secondary"),
    ("Panthapath",           90.3800, 23.7520, 90.3950, 23.7520, "primary"),
    ("Green Road",           90.3730, 23.7500, 90.3800, 23.7550, "secondary"),
    ("Sonargaon Road",       90.3950, 23.7520, 90.4050, 23.7520, "primary"),
    ("New Eskaton Road",     90.3980, 23.7450, 90.4000, 23.7550, "secondary"),
    ("Outer Circular Road",  90.3800, 23.7200, 90.3900, 23.7150, "secondary"),
    ("Inner Circular Road",  90.3870, 23.7250, 90.3950, 23.7200, "secondary"),
    ("Progoti Sarani",       90.4200, 23.7800, 90.4400, 23.8000, "primary"),
    ("Dhaka-Mymensingh Road",90.4000, 23.8000, 90.4000, 23.8300, "trunk"),
    ("Uttara Sector Road",   90.3900, 23.8100, 90.4100, 23.8200, "secondary"),
    ("Abdus Salam Road",     90.3800, 23.7700, 90.3900, 23.7700, "tertiary"),
    ("Crescent Road",        90.4100, 23.7850, 90.4150, 23.7880, "tertiary"),
    ("Tin Rashta (Khilgaon)",90.4200, 23.7400, 90.4300, 23.7500, "secondary"),
    ("Shantinagar Road",     90.4100, 23.7400, 90.4150, 23.7500, "tertiary"),
    ("DIT Road",             90.4100, 23.7500, 90.4200, 23.7550, "secondary"),
    ("Wireless Gate Road",   90.3950, 23.7700, 90.4050, 23.7750, "tertiary"),
    ("Mohammadpur Bus Stand Road", 90.3550, 23.7620, 90.3650, 23.7620, "tertiary"),
    ("Rayerbazar Road",      90.3550, 23.7500, 90.3600, 23.7600, "tertiary"),
    ("Zigatala Road",        90.3700, 23.7380, 90.3750, 23.7420, "tertiary"),
]

# ── Police stations ────────────────────────────────────────────
POLICE_STATIONS = [
    (90.3760, 23.7470),  # Dhanmondi
    (90.4150, 23.7890),  # Gulshan
    (90.4040, 23.7950),  # Banani
    (90.3650, 23.7950),  # Mirpur
    (90.3600, 23.7600),  # Mohammadpur
    (90.4000, 23.8200),  # Uttara (South)
    (90.3900, 23.8250),  # Uttara (North)
    (90.3960, 23.7380),  # Ramna
    (90.4100, 23.7310),  # Motijheel
    (90.3850, 23.7250),  # Lalbagh
    (90.3950, 23.7150),  # Kotwali
    (90.3950, 23.7700),  # Tejgaon
    (90.4250, 23.7450),  # Khilgaon
    (90.4300, 23.7800),  # Badda
    (90.4100, 23.7100),  # Jatrabari
    (90.3550, 23.8050),  # Pallabi
    (90.3930, 23.7370),  # Shahbag
    (90.3700, 23.7900),  # Kafrul
    (90.4100, 23.8000),  # Cantonment
    (90.4350, 23.7600),  # Rampura
    (90.3900, 23.7560),  # Farmgate (New Market)
    (90.4000, 23.7200),  # Chawkbazar
    (90.3650, 23.7300),  # Kamrangirchar
    (90.4000, 23.7500),  # Paltan
    (90.4200, 23.7300),  # Demra
    (90.3800, 23.7700),  # Sher-e-Bangla Nagar
    (90.4250, 23.8050),  # Bashundhara
    (90.3550, 23.7750),  # Adabor
    (90.4150, 23.7700),  # Hatirjheel
    (90.3850, 23.7100),  # Hazaribagh
]

# ── Hospitals ──────────────────────────────────────────────────
HOSPITALS = [
    (90.3960, 23.7260),  # Dhaka Medical College Hospital
    (90.3920, 23.7400),  # BIRDEM Hospital
    (90.3870, 23.7510),  # Square Hospital
    (90.4200, 23.7950),  # United Hospital
    (90.4300, 23.8100),  # Evercare Hospital (Bashundhara)
    (90.4150, 23.7850),  # Apollo Hospital Dhaka
    (90.3950, 23.7550),  # National Heart Foundation
    (90.3900, 23.7480),  # Popular Hospital
    (90.3860, 23.7420),  # Ibn Sina Hospital (Dhanmondi)
    (90.3750, 23.7500),  # Labaid Hospital
    (90.4050, 23.7350),  # Sir Salimullah Medical College
    (90.3700, 23.7450),  # Green Life Hospital
    (90.3980, 23.7700),  # Japan Friendship Hospital
    (90.4100, 23.7900),  # Gulshan Clinic
    (90.3600, 23.7620),  # Shaheed Suhrawardy Medical College
    (90.4000, 23.8150),  # Crescent Hospital (Uttara)
    (90.3900, 23.7150),  # Mitford Hospital
    (90.3650, 23.7850),  # Mirpur General Hospital
    (90.3850, 23.7600),  # Kurmitola General Hospital
    (90.4100, 23.7500),  # Holy Family Red Crescent Hospital
    (90.3980, 23.7250),  # Bangabandhu Sheikh Mujib Medical Univ.
    (90.4350, 23.7700),  # Anwer Khan Modern Hospital (Rampura)
    (90.3550, 23.7600),  # Ibrahim General Hospital (Mohammadpur)
]

# ── Grid generation ────────────────────────────────────────────
# We'll create a ~72x72 grid = ~5184 nodes, then remove some for realism
GRID_X = 72
GRID_Y = 72
LON_STEP = (EAST - WEST) / (GRID_X - 1)
LAT_STEP = (NORTH - SOUTH) / (GRID_Y - 1)


def haversine(lon1, lat1, lon2, lat2):
    """Distance in metres between two (lon, lat) points."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def get_risk_level(lon, lat):
    """Return the risk level for a given (lon, lat) based on proximity to risk zones."""
    closest_level = 2  # default moderate
    closest_dist = float("inf")
    for zlon, zlat, zrad, _, _, zlevel, _, _ in RISK_ZONES:
        dist = math.sqrt((lon - zlon) ** 2 + (lat - zlat) ** 2)
        if dist < zrad and dist < closest_dist:
            closest_dist = dist
            closest_level = zlevel
    return closest_level


def police_distance(lon, lat):
    """Return min distance (degrees) to any police station."""
    return min(math.sqrt((lon - px) ** 2 + (lat - py) ** 2) for px, py in POLICE_STATIONS)


def police_risk(lon, lat):
    """Police risk: lower when close to police stations."""
    d = police_distance(lon, lat)
    # scale: 0km -> 0.1 risk, 2km (~0.018deg) -> 0.9 risk
    return min(0.9, max(0.1, d / 0.018 * 0.8 + 0.1))


def assign_road_name(lon1, lat1, lon2, lat2, names_list, names_index):
    """Check if an edge is close to a named road and return its name index or -1."""
    mx, my = (lon1 + lon2) / 2, (lat1 + lat2) / 2
    for road_name, sx, sy, ex, ey, _ in NAMED_ROADS:
        # project midpoint onto road segment
        dx, dy = ex - sx, ey - sy
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq == 0:
            continue
        t = max(0, min(1, ((mx - sx) * dx + (my - sy) * dy) / seg_len_sq))
        px, py = sx + t * dx, sy + t * dy
        dist = math.sqrt((mx - px) ** 2 + (my - py) ** 2)
        if dist < 0.003:  # within ~300m
            if road_name not in names_index:
                names_index[road_name] = len(names_list)
                names_list.append(road_name)
            return names_index[road_name]
    return -1


def get_highway_type(lon, lat):
    """Return a highway type based on proximity to major roads."""
    for _, sx, sy, ex, ey, hw in NAMED_ROADS:
        dx, dy = ex - sx, ey - sy
        seg_len_sq = dx * dx + dy * dy
        if seg_len_sq == 0:
            continue
        t = max(0, min(1, ((lon - sx) * dx + (lat - sy) * dy) / seg_len_sq))
        px, py = sx + t * dx, sy + t * dy
        dist = math.sqrt((lon - px) ** 2 + (lat - py) ** 2)
        if dist < 0.002:
            return hw
    return random.choice(["residential", "residential", "residential", "tertiary", "unclassified"])


def main():
    # ── Build grid nodes ──────────────────────────────────────
    nodes = []
    grid = {}  # (ix, iy) -> node_index

    for iy in range(GRID_Y):
        for ix in range(GRID_X):
            # Remove some nodes randomly for realism (keep ~85%)
            # But always keep nodes near named roads, police, hospitals
            lon = WEST + ix * LON_STEP
            lat = SOUTH + iy * LAT_STEP
            keep = True
            if random.random() > 0.85:
                # Check if near important locations
                near_important = False
                for _, sx, sy, ex, ey, _ in NAMED_ROADS:
                    dx, dy = ex - sx, ey - sy
                    seg_len_sq = dx * dx + dy * dy
                    if seg_len_sq == 0:
                        continue
                    t = max(0, min(1, ((lon - sx) * dx + (lat - sy) * dy) / seg_len_sq))
                    px, py = sx + t * dx, sy + t * dy
                    if math.sqrt((lon - px) ** 2 + (lat - py) ** 2) < 0.003:
                        near_important = True
                        break
                if not near_important:
                    for px, py in POLICE_STATIONS + HOSPITALS:
                        if math.sqrt((lon - px) ** 2 + (lat - py) ** 2) < 0.005:
                            near_important = True
                            break
                if not near_important:
                    keep = False

            if keep:
                # Add slight jitter for realism
                jlon = lon + random.uniform(-LON_STEP * 0.15, LON_STEP * 0.15)
                jlat = lat + random.uniform(-LAT_STEP * 0.15, LAT_STEP * 0.15)
                # Clamp to bbox
                jlon = max(WEST, min(EAST, jlon))
                jlat = max(SOUTH, min(NORTH, jlat))
                idx = len(nodes)
                nodes.append([round(jlon, 5), round(jlat, 5)])
                grid[(ix, iy)] = idx

    print(f"Generated {len(nodes)} nodes")

    # ── Build edges ───────────────────────────────────────────
    edges = []
    names_list = []
    names_index = {}
    edge_set = set()

    # Add extra street names from real Dhaka
    extra_names = [
        "Road 1", "Road 2", "Road 3", "Road 4", "Road 5", "Road 6", "Road 7",
        "Road 8", "Road 9", "Road 10", "Road 11", "Road 12", "Road 13A",
        "Road 15", "Road 16", "Road 27",
        "Lane 1", "Lane 2", "Lane 3",
        "Sector 1 Road", "Sector 3 Road", "Sector 4 Road", "Sector 7 Road",
        "Sector 10 Road", "Sector 11 Road", "Sector 13 Road",
        "Purana Paltan Lane", "Naya Paltan Road", "Bijoynagar Road",
        "Kakrail Road", "Segunbagicha Road", "Tipu Sultan Road",
        "Bongshal Lane", "Shakhari Bazar", "Tanti Bazar",
        "Sadarghat Road", "Lalbagh Road", "Azimpur Road",
        "Chankharpul Road", "Wari Road", "Narinda Road",
        "Gandaria Road", "Sutrapur Road", "Swamibag Road",
        "Dholaikhal Road", "Jatrabari Main Road", "Demra Road",
        "Basabo Road", "Khilgaon Road", "Mugda Road",
        "Malibagh Chowdhury Para", "Mouchak Road", "Siddheshwari Road",
        "Shantinagar", "Ittefaq Road", "Circular Road",
        "Eskaton Garden Road", "Banglamotor Road", "Paribagh Road",
        "Indira Road", "Tejturi Bazar Road", "Monipuripara Road",
        "Lalmatia Road", "Mohammadpur Town Hall Road", "Asad Avenue",
        "Japan Garden City Road", "Adabor Road", "Shyamoli Road",
        "Agargaon Road", "Taltala Road", "Mirpur 1 Road",
        "Mirpur 2 Road", "Mirpur 10 Road", "Mirpur 11 Road",
        "Mirpur 12 Road", "Pallabi Main Road", "Rupnagar Road",
        "Section 6 Road", "Section 12 Road", "Kazipara Road",
        "Pirerbag Road", "Ibrahimpur Road", "Kafrul Road",
        "Cantonment Board Road", "ECB Chattar Road",
        "Gulshan 1 Road", "Gulshan 2 Road", "Gulshan Link Road",
        "Baridhara Road", "Nadda Road", "Kuril Road",
        "Bashundhara Road", "Apollo Road", "Block A Road",
        "Block B Road", "Block C Road", "Block D Road",
        "Block E Road", "Block F Road", "Block G Road",
        "Nikunja 1 Road", "Nikunja 2 Road",
        "Uttara Sector 1 Road", "Uttara Sector 3 Road",
        "Uttara Sector 4 Road", "Uttara Sector 7 Road",
        "Uttara Sector 9 Road", "Uttara Sector 10 Road",
        "Uttara Sector 11 Road", "Uttara Sector 13 Road",
        "Rajlokkhi Road", "Jasimuddin Road", "Azampur Road",
        "Shahjalal Avenue", "Kuril Flyover Road",
    ]
    for n in extra_names:
        if n not in names_index:
            names_index[n] = len(names_list)
            names_list.append(n)

    # Connect grid neighbors (4-connectivity + some diagonals)
    for (ix, iy), u in grid.items():
        for dix, diy in [(1, 0), (0, 1), (1, 1), (-1, 1)]:
            nix, niy = ix + dix, iy + diy
            if (nix, niy) in grid:
                v = grid[(nix, niy)]
                edge_key = (min(u, v), max(u, v))
                if edge_key in edge_set:
                    continue
                edge_set.add(edge_key)

                lon1, lat1 = nodes[u]
                lon2, lat2 = nodes[v]
                length = round(haversine(lon1, lat1, lon2, lat2), 1)

                # Determine highway type and name
                hw = get_highway_type((lon1 + lon2) / 2, (lat1 + lat2) / 2)
                name_idx = assign_road_name(lon1, lat1, lon2, lat2, names_list, names_index)

                # If no named road assigned, sometimes assign a generic name
                if name_idx == -1 and random.random() < 0.15:
                    # Pick a random extra name based on location
                    area_idx = int((lon1 - WEST) / (EAST - WEST) * len(extra_names)) % len(extra_names)
                    name_idx = names_index[extra_names[area_idx]]

                # Risk scoring based on zone
                risk_level = get_risk_level((lon1 + lon2) / 2, (lat1 + lat2) / 2)
                base_light, base_road, base_act = RISK_MAP[risk_level]

                # Add some randomness
                lighting_risk = round(min(0.95, max(0.05, base_light + random.gauss(0, 0.08))), 2)
                road_risk = round(min(0.95, max(0.05, base_road + random.gauss(0, 0.06))), 2)
                activity_risk = round(min(0.95, max(0.05, base_act + random.gauss(0, 0.08))), 2)
                pol_risk = round(police_risk((lon1 + lon2) / 2, (lat1 + lat2) / 2), 3)

                # lit_known: 15% chance of being known (from OSM tagging)
                lit_known = 1 if random.random() < 0.15 else 0

                # For diagonal edges, add a midpoint
                if abs(dix) + abs(diy) == 2:
                    mid = [[round((lon1 + lon2) / 2 + random.uniform(-0.0003, 0.0003), 5),
                            round((lat1 + lat2) / 2 + random.uniform(-0.0003, 0.0003), 5)]]
                    midpoints = mid
                else:
                    # Sometimes add midpoints for straight edges too (curved roads)
                    if random.random() < 0.25:
                        mid_lon = round((lon1 + lon2) / 2 + random.uniform(-0.0005, 0.0005), 5)
                        mid_lat = round((lat1 + lat2) / 2 + random.uniform(-0.0005, 0.0005), 5)
                        midpoints = [[mid_lon, mid_lat]]
                    else:
                        midpoints = 0

                edges.append([u, v, length, hw, name_idx, lighting_risk, road_risk,
                              activity_risk, pol_risk, lit_known, midpoints])

    print(f"Generated {len(edges)} edges, {len(names_list)} street names")

    # ── Activity points ───────────────────────────────────────
    # Count nodes that are in "active" areas (commercial, transit hubs)
    activity_zones = [
        (90.3760, 23.7470, 0.012),  # Dhanmondi (New Market)
        (90.4150, 23.7890, 0.010),  # Gulshan
        (90.4040, 23.7950, 0.008),  # Banani
        (90.4100, 23.7310, 0.010),  # Motijheel
        (90.3900, 23.7560, 0.008),  # Farmgate
        (90.3870, 23.7400, 0.008),  # Shahbag
        (90.3950, 23.7150, 0.008),  # Chawkbazar
        (90.3800, 23.7520, 0.008),  # Panthapath
        (90.4000, 23.8200, 0.010),  # Uttara
        (90.3600, 23.7600, 0.008),  # Mohammadpur
    ]
    activity_count = 0
    for lon, lat in nodes:
        for ax, ay, ar in activity_zones:
            if math.sqrt((lon - ax) ** 2 + (lat - ay) ** 2) < ar:
                activity_count += 1
                break

    # ── Build output ──────────────────────────────────────────
    output = {
        "meta": {
            "area": {"bn": "ঢাকা মহানগরী", "en": "Dhaka Metropolitan Area"},
            "generated": str(date.today()),
            "bbox": [WEST, SOUTH, EAST, NORTH],
            "weights": {"lighting": 0.35, "road": 0.25, "activity": 0.2, "police": 0.2},
            "night_mult": {"lighting": 1.5, "activity": 1.25},
            "alphas": {"shortest": 0.0, "balanced": 2.0, "safest": 6.0},
            "high_risk": 0.6,
            "light_unknown": 0.5,
            "edge_fields": ["u", "v", "len", "hw", "name", "light", "road", "act", "pol", "lit_known", "mid"],
            "counts": {
                "nodes": len(nodes),
                "edges": len(edges),
                "police": len(POLICE_STATIONS),
                "hospital": len(HOSPITALS),
                "activity": activity_count,
            },
            "lit_tag_share": 0.15,
            "credit": "Mock data based on news reports and OpenStreetMap structure",
        },
        "nodes": nodes,
        "names": names_list,
        "edges": edges,
        "pois": {
            "police": [[round(lon, 5), round(lat, 5)] for lon, lat in POLICE_STATIONS],
            "hospital": [[round(lon, 5), round(lat, 5)] for lon, lat in HOSPITALS],
            "metro": [{"name": m[0], "name_bn": m[1], "ll": [round(m[2], 5), round(m[3], 5)]} for m in METRO_STATIONS],
        },
        "zones": [
            {
                "name": z[3],
                "name_bn": z[4],
                "lon": round(z[0], 5),
                "lat": round(z[1], 5),
                "r_m": round(z[2] * 111000),
                "level": z[5],
                "caution": z[6],
                "tip": z[7]
            }
            for z in RISK_ZONES
        ],
    }

    # ── Write output ──────────────────────────────────────────
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "area.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    file_size = os.path.getsize(out_path)
    print(f"Written to {out_path}")
    print(f"File size: {file_size / 1024:.1f} KB")
    print(f"Nodes: {len(nodes)}, Edges: {len(edges)}")
    print(f"Police: {len(POLICE_STATIONS)}, Hospitals: {len(HOSPITALS)}")
    print(f"Street names: {len(names_list)}")
    print(f"Activity zones: {activity_count} nodes")


if __name__ == "__main__":
    main()
