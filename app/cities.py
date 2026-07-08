"""Přiřazení souřadnice k městu – offline číselník.

Používá kniha jízd v režimu „zapisovat po městech": jízdy uvnitř jednoho
města se slučují pod jeho jméno (Brno, Praha…). Poloměr města se odvozuje
od počtu obyvatel; mimo poloměr se bere nejbližší město do 25 km (vesnice
spadají pod nejbližší město, což je pro knihu jízd žádoucí).
"""
from __future__ import annotations

import math

from .common import haversine_m

# (název, lat, lon, přibližný počet obyvatel)
CITIES: list[tuple[str, float, float, int]] = [
    ("Praha", 50.0755, 14.4378, 1_300_000),
    ("Brno", 49.1951, 16.6068, 380_000),
    ("Ostrava", 49.8209, 18.2625, 285_000),
    ("Plzeň", 49.7384, 13.3736, 175_000),
    ("Liberec", 50.7663, 15.0543, 104_000),
    ("Olomouc", 49.5938, 17.2509, 100_000),
    ("České Budějovice", 48.9745, 14.4743, 94_000),
    ("Hradec Králové", 50.2092, 15.8328, 92_000),
    ("Ústí nad Labem", 50.6607, 14.0322, 92_000),
    ("Pardubice", 50.0343, 15.7812, 91_000),
    ("Zlín", 49.2265, 17.6707, 74_000),
    ("Havířov", 49.7798, 18.4368, 70_000),
    ("Kladno", 50.1473, 14.1028, 69_000),
    ("Most", 50.5031, 13.6362, 65_000),
    ("Opava", 49.9407, 17.8948, 55_000),
    ("Frýdek-Místek", 49.6825, 18.3673, 55_000),
    ("Jihlava", 49.3961, 15.5912, 51_000),
    ("Karviná", 49.8540, 18.5417, 50_000),
    ("Teplice", 50.6404, 13.8245, 49_000),
    ("Děčín", 50.7726, 14.2128, 48_000),
    ("Karlovy Vary", 50.2306, 12.8710, 48_000),
    ("Chomutov", 50.4605, 13.4178, 48_000),
    ("Jablonec nad Nisou", 50.7243, 15.1681, 45_000),
    ("Mladá Boleslav", 50.4114, 14.9032, 45_000),
    ("Prostějov", 49.4720, 17.1067, 43_000),
    ("Přerov", 49.4550, 17.4509, 42_000),
    ("Česká Lípa", 50.6855, 14.5377, 37_000),
    ("Třebíč", 49.2149, 15.8817, 35_000),
    ("Třinec", 49.6776, 18.6708, 34_000),
    ("Tábor", 49.4144, 14.6578, 34_000),
    ("Znojmo", 48.8555, 16.0488, 34_000),
    ("Příbram", 49.6899, 14.0104, 32_000),
    ("Cheb", 50.0796, 12.3740, 32_000),
    ("Kolín", 50.0282, 15.2006, 32_000),
    ("Trutnov", 50.5610, 15.9127, 30_000),
    ("Písek", 49.3088, 14.1475, 30_000),
    ("Orlová", 49.8452, 18.4302, 28_000),
    ("Kroměříž", 49.2979, 17.3931, 28_000),
    ("Vsetín", 49.3387, 17.9962, 25_000),
    ("Šumperk", 49.9653, 16.9707, 25_000),
    ("Uherské Hradiště", 49.0698, 17.4597, 25_000),
    ("Břeclav", 48.7589, 16.8820, 24_000),
    ("Hodonín", 48.8489, 17.1324, 24_000),
    ("Litoměřice", 50.5335, 14.1318, 23_000),
    ("Havlíčkův Brod", 49.6060, 15.5796, 23_000),
    ("Nový Jičín", 49.5944, 18.0103, 23_000),
    ("Chrudim", 49.9511, 15.7956, 23_000),
    ("Krnov", 50.0897, 17.7039, 23_000),
    ("Strakonice", 49.2614, 13.9024, 22_000),
    ("Sokolov", 50.1814, 12.6402, 22_000),
    ("Valašské Meziříčí", 49.4718, 17.9711, 22_000),
    ("Klatovy", 49.3956, 13.2951, 22_000),
    ("Kopřivnice", 49.5995, 18.1448, 21_000),
    ("Jindřichův Hradec", 49.1444, 15.0030, 21_000),
    ("Kutná Hora", 49.9484, 15.2681, 21_000),
    ("Vyškov", 49.2775, 16.9989, 20_000),
    ("Žďár nad Sázavou", 49.5626, 15.9392, 20_000),
    ("Blansko", 49.3630, 16.6444, 20_000),
    ("Beroun", 49.9640, 14.0720, 20_000),
    ("Bohumín", 49.9041, 18.3576, 20_000),
    ("Náchod", 50.4167, 16.1628, 19_000),
    ("Louny", 50.3571, 13.7968, 18_000),
    ("Kadaň", 50.3760, 13.2714, 18_000),
    ("Hranice", 49.5480, 17.7346, 18_000),
    ("Otrokovice", 49.2099, 17.5307, 17_000),
    ("Svitavy", 49.7559, 16.4684, 17_000),
    ("Uherský Brod", 49.0251, 17.6472, 16_000),
    ("Rožnov pod Radhoštěm", 49.4585, 18.1430, 16_000),
    ("Bruntál", 49.9882, 17.4647, 16_000),
    ("Slaný", 50.2306, 14.0869, 16_000),
    ("Pelhřimov", 49.4306, 15.2231, 16_000),
    ("Šternberk", 49.7305, 17.2989, 13_500),
    ("Rakovník", 50.1036, 13.7334, 15_500),
    ("Benešov", 49.7816, 14.6870, 16_500),
    ("Nymburk", 50.1861, 15.0417, 15_000),
    ("Poděbrady", 50.1424, 15.1189, 14_500),
    ("Milovice", 50.2260, 14.8883, 12_500),
    ("Brandýs nad Labem", 50.1867, 14.6635, 19_000),
    ("Říčany", 49.9917, 14.6547, 16_500),
    ("Čelákovice", 50.1602, 14.7500, 12_000),
    ("Turnov", 50.5874, 15.1568, 14_500),
    ("Dvůr Králové nad Labem", 50.4319, 15.8143, 15_500),
    ("Jičín", 50.4373, 15.3517, 16_500),
    ("Vysoké Mýto", 49.9532, 16.1617, 12_000),
    ("Ústí nad Orlicí", 49.9737, 16.3937, 14_000),
    ("Česká Třebová", 49.9019, 16.4472, 15_500),
    ("Lanškroun", 49.9122, 16.6121, 10_000),
    ("Litomyšl", 49.8722, 16.3106, 10_000),
    ("Polička", 49.7146, 16.2657, 8_800),
    ("Moravská Třebová", 49.7580, 16.6643, 10_000),
    ("Zábřeh", 49.8826, 16.8722, 13_500),
    ("Mohelnice", 49.7770, 16.9195, 9_200),
    ("Litovel", 49.7013, 17.0761, 9_800),
    ("Uničov", 49.7709, 17.1215, 11_500),
    ("Holešov", 49.3332, 17.5783, 11_500),
    ("Bystřice pod Hostýnem", 49.3993, 17.6742, 8_300),
    ("Kyjov", 49.0102, 17.1225, 11_000),
    ("Veselí nad Moravou", 48.9536, 17.3766, 10_800),
    ("Strážnice", 48.9002, 17.3169, 5_500),
    ("Dubňany", 48.9177, 17.0900, 6_300),
    ("Ivančice", 49.1015, 16.3776, 10_000),
    ("Kuřim", 49.2985, 16.5314, 11_000),
    ("Rosice", 49.1826, 16.3880, 6_200),
    ("Zastávka", 49.1861, 16.3653, 2_600),
    ("Slavkov u Brna", 49.1533, 16.8764, 7_100),
    ("Šlapanice", 49.1687, 16.7284, 7_600),
    ("Modřice", 49.1279, 16.6134, 5_500),
    ("Rajhrad", 49.0903, 16.6039, 3_800),
    ("Židlochovice", 49.0399, 16.6187, 3_900),
    ("Pohořelice", 48.9819, 16.5247, 5_100),
    ("Mikulov", 48.8055, 16.6378, 7_500),
    ("Hustopeče", 48.9410, 16.7376, 6_000),
    ("Velké Pavlovice", 48.9046, 16.8145, 3_100),
    ("Moravský Krumlov", 49.0489, 16.3118, 5_700),
    ("Miroslav", 48.9479, 16.3126, 3_000),
    ("Hrušovany nad Jevišovkou", 48.8296, 16.4029, 3_300),
    ("Jevišovice", 48.9868, 15.9895, 1_200),
    ("Vranov nad Dyjí", 48.8935, 15.8119, 800),
    ("Tišnov", 49.3487, 16.4245, 9_500),
    ("Boskovice", 49.4875, 16.6606, 11_500),
    ("Letovice", 49.5471, 16.5737, 6_500),
    ("Velká Bíteš", 49.2887, 16.2261, 5_200),
    ("Velké Meziříčí", 49.3553, 16.0122, 11_500),
    ("Náměšť nad Oslavou", 49.2072, 16.1580, 4_900),
    ("Dačice", 49.0816, 15.4372, 7_300),
    ("Telč", 49.1842, 15.4528, 5_300),
    ("Moravské Budějovice", 49.0521, 15.8087, 7_300),
    ("Jemnice", 49.0187, 15.5699, 4_000),
    ("Jaroměřice nad Rokytnou", 49.0940, 15.8933, 4_100),
    ("Hrotovice", 49.1078, 16.0611, 1_800),
    ("Bratislava", 48.1486, 17.1077, 430_000),
    ("Vídeň", 48.2082, 16.3738, 1_900_000),
]


def _radius_km(pop: int) -> float:
    """Přibližný poloměr zástavby podle velikosti města."""
    return min(16.0, max(2.2, 1.2 + math.sqrt(pop) / 85))


def city_for(lat: float | None, lon: float | None) -> str | None:
    """Město, do kterého souřadnice patří; None mimo dosah číselníku."""
    if lat is None or lon is None:
        return None
    best_name, best_score = None, float("inf")
    nearest_name, nearest_d = None, float("inf")
    for name, clat, clon, pop in CITIES:
        if abs(clat - lat) > 0.30 or abs(clon - lon) > 0.45:
            continue
        d_km = haversine_m(lat, lon, clat, clon) / 1000
        if d_km < nearest_d:
            nearest_name, nearest_d = name, d_km
        r = _radius_km(pop)
        if d_km <= r and d_km / r < best_score:
            best_name, best_score = name, d_km / r
    if best_name:
        return best_name
    if nearest_d <= 25:
        return nearest_name
    return None
