const fs = require('fs');
const path = require('path');

const instagramRows = [
    { countryId: 48, price: 30 },
    { countryId: 82, price: 30 },
    { countryId: 33, price: 25 },
    { countryId: 31, price: 25 },
    { countryId: 43, price: 25 },
    { countryId: 8, price: 40 },
    { countryId: 54, price: 40 },
    { countryId: 4, price: 40 },
    { countryId: 73, price: 40 },
    { countryId: 103, price: 45 },
    { countryId: 22, price: 50 },
    { countryId: 151, price: 40 },
    { countryId: 19, price: 50 },
    { countryId: 30, price: 50 },
    { countryId: 47, price: 50 },
    { countryId: 65, price: 40 },
    { countryId: 70, price: 40 },
    { countryId: 156, price: 70 },
    { countryId: 1001, price: 90 },
    { countryId: 42, price: 40 },
    { countryId: 60, price: 170 },
    { countryId: 66, price: 40 },
    { countryId: 9, price: 35 },
    { countryId: 80, price: 20 },
    { countryId: 1, price: 30 },
    { countryId: 37, price: 18 },
    { countryId: 100, price: 170 },
    { countryId: 36, price: 17 },
    { countryId: 34, price: 44 },
    { countryId: 7, price: 44 },
    { countryId: 76, price: 39 },
    { countryId: 175, price: 47 },
    { countryId: 27, price: 45 },
    { countryId: 38, price: 43 }
];

const snapchatCountryIds = [
    33, 22, 12, 151, 78, 46, 86, 88, 36, 95, 56, 62, 175, 129, 82, 48, 73, 43, 32, 25, 15, 60, 31, 66, 50,
    54, 61, 163, 23, 37, 16, 7, 174, 6, 196, 38, 89, 97, 4, 153, 161, 24, 172, 147, 138, 79, 58, 71, 80,
    76, 1, 21, 57, 65, 96, 81, 40, 106, 18, 123, 64, 39, 5, 91, 136, 105, 101, 75, 137, 8, 112, 103, 70,
    2, 87, 11, 116, 41, 27, 83, 102, 157, 69, 140, 154, 90, 85, 52, 120, 93, 152, 111, 146, 107, 150, 30,
    156, 47, 99, 139, 158, 119, 167, 104, 177, 114, 3, 100, 130, 159, 108, 149, 118, 28, 148, 131, 42, 173,
    29, 34, 145, 160, 77, 165, 142, 94, 17, 169, 168, 162, 164, 171, 113, 115, 122, 92, 127, 49, 143, 121,
    170, 166, 155, 59, 134, 44, 125, 135, 1001, 68, 179, 133, 141, 181, 178, 45, 186, 144, 183, 124, 185,
    67, 72, 184, 180, 126, 20, 132, 176, 201
];

const snapchatPricesRaw = `
colombia 11
india 70
usa virtual 10
chile 10
france 30
sweden 16
italy 30
honduras 100
canada 37
uae 100
spain 60
turkey 170
australia 76
greece 40
belgium 200
netherlands 40
brazil 17
germany 37
romania 33
lao peoples 40 poland 27 bangladesh 70 south africa 14 pakistan 70 austria 140 mexico 80 senegal 60 finland 200 ireland 60 morocco 70 uk 18 malaysia 30 norway 140 indonesia 9 singapor 180 ghana 70 tunisia 100 puerto rico 100 philippines 27 lebanon 100 turkmenistan 100 cambodia 200 denmark 70 zambia 120 namibia 120 papua new gvineya 18 algeria 70 ethiopia 34 mozambique 18 angola 110 ukraine 18 egypt 80 iran 60 peru 30 zimbabwe 19 nepal 110 uzbekistan 23 swaziland 60 congo (dem. republic) 30 botswana 100 sri lanka 90 argentinas 13 myanmar 80 timor-leste 14 lesotho 30 ecuador 100 el salvador 90 uganda 30 malawi 30 kenya 30 panama 30 jamaica 90 venezuela 200 kazakhstan 30 paraguay 100 kyrgyzstan 200 jordan 100 cameroon 30 cote divoire ivory coast 30
bulgaria 30
libya 80
mauritius 100
mali 30
rwanda 30
gabon 30
nicaragua 30
moldova 30
thailand 30
benin 100
costa rica 100
burkina faso 30
qatar 100
reunion 110
oman 110
congo 30
yemen 70
uruguay 30
iraq 100
togo 30
niger 30
bhutan 70
burundi 30
equatorial guinea 100
trinidad and tobago 60
south sudan 30
mauritania 100
china 130
kuwait 110
guinea-bissau 110
maldives 100
bosnia and herzegovina 140
somalia 30
barbados 200
gambia 100
armenia 230
guyana 30
chad 100
switzerland 130
serbia 140
estonia 40
bahrain 30
guadeloupe 100
cyprus 30
luxembourg 140
suriname 30
guatemala 30
madagascar 110
antigua and barbuda 110
djibouti 110
french guiana 100
saint lucia 100
montenegro 30
cuba 30
sierra leone 30
bahamas 100
bolivia 30
grenada 100
latvia 30
tajikistan 30
brunei darussalam 30
cayman islands 170
saint vincent 120
albania 140
slovenia 30
saint kitts and nevis 30
lithuania 200
caf 30
liberia 110
japan 110
guinea 30
aruba 30
comoros 100
slovakia 110
anguilla 80
sao tome and principe 30
croatia 30
cape verde 30
monaco 100
macedonia 110
belize 30
new caledonia 100
new zealand 78
mongolia 30
seychelles 30
montserrat 100
dominica 70
macau 70
iceland 30
eritrea 100
gibraltar 400
`;

const facebookTable = `
| Country Name (standardized) | ID | Price (Rs) |
|-----------------------------|----|-------------|
| Ethiopia | 71 | 32 |
| Yemen | 30 | 35 |
| Indonesia | 6 | 28 |
| Kenya | 8 | 31 |
| Nigeria | 19 | 34 |
| Colombia | 33 | 29 |
| Brazil | 73 | 36 |
| South Africa | 31 | 33 |
| Tanzania | 9 | 30 |
| India | 22 | 38 |
| Spain | 56 | 28 |
| Philippines | 4 | 32 |
| Cambodia | 24 | 35 |
| Chile | 151 | 31 |
| Saudi Arabia | 53 | 34 |
| Ghana | 38 | 29 |
| Argentinas | 39 | 37 |
| Sri Lanka | 64 | 30 |
| Sweden | 46 | 33 |
| Ukraine | 1 | 36 |
| Viet nam | 10 | 28 |
| Germany | 43 | 38 |
| Bulgaria | 83 | 31 |
| Poland | 15 | 34 |
| Thailand | 52 | 29 |
| Mozambique | 80 | 35 |
| Mexico | 54 | 32 |
| Jamaica | 103 | 100 |
| Ecuador | 105 | 30 |
| Syria (Syrian Arab Republic) | 1333 | 37 |
| Guatemala | 94 | 80 |
| France | 78 | 33 |
| Morocco | 37 | 28 |
| Malaysia | 7 | 36 |
| Portugal | 117 | 31 |
| Turkey | 62 | 34 |
| Uruguay | 156 | 29 |
| Bangladesh | 60 | 70 |
| Romania | 32 | 35 |
| Italy | 86 | 32 |
| Australia | 175 | 38 |
| Paraguay | 87 | 30 |
| Guyana | 131 | 33 |
| Iraq | 47 | 37 |
| Congo | 150 | 70 |
| Cameroon | 41 | 28 |
| Czech Republic | 63 | 36 |
| Timor-Leste | 91 | 80 |
| Venezuela | 70 | 31 |
| Pakistan | 66 | 34 |
| Zambia | 147 | 29 |
| Senegal | 61 | 35 |
| Trinidad and Tobago | 104 | 32 |
| Suriname | 142 | 70 |
| Burkina Faso | 152 | 30 |
| Netherlands | 48 | 38 |
| Denmark | 172 | 33 |
| Tunisia | 89 | 80 |
| Kazakhstan | 2 | 36 |
| Latvia | 49 | 28 |
| Uganda | 75 | 31 |
| Greece | 129 | 34 |
| Estonia | 34 | 29 |
| Fiji | 189 | 70 |
| Taiwan | 55 | 35 |
| Kyrgyzstan | 11 | 32 |
| Bolivia | 92 | 37 |
| Haiti | 26 | 30 |
| Myanmar | 5 | 33 |
| Dominican Republic | 109 | 70 |
| Belgium | 82 | 36 |
| Swaziland | 106 | 28 |
| Kuwait | 100 | 90 |
| Lao Peoples | 25 | 31 |
| Niger | 139 | 100 |
| Tajikistan | 143 | 34 |
| Qatar | 111 | 90 |
| El Salvador | 101 | 80 |
| New Zealand | 67 | 80 |
| Libya | 102 | 90 |
| Honduras | 88 | 29 |
| UAE | 95 | 60 |
| Namibia | 138 | 60 |
| Equatorial Guinea | 167 | 80 |
| Somalia | 149 | 70 |
| Jordan | 116 | 35 |
| Afghanistan | 74 | 32 |
| Peru | 65 | 38 |
| Egypt | 21 | 30 |
| Georgia | 128 | 33 |
| Finland | 163 | 36 |
| Papua new gvineya | 79 | 70 |
| Cote dIvoire Ivory Coast | 27 | 28 |
| Chad | 42 | 31 |
| Nepal | 81 | 34 |
| Moldova (Moldova, Republic of) | 85 | 29 |
| Croatia | 45 | 35 |
| Nicaragua | 90 | 32 |
| Cuba | 113 | 120 |
| Mongolia | 72 | 37 |
| Slovenia | 59 | 30 |
| Benin | 120 | 33 |
| Belarus | 51 | 100 |
| Botswana | 123 | 100 |
| Congo (Dem. Republic) | 18 | 36 |
| Madagascar | 17 | 28 |
| Algeria | 58 | 31 |
| Austria | 50 | 34 |
| Panama | 112 | 29 |
| Norway | 174 | 35 |
| Ireland | 23 | 32 |
| Mauritius | 157 | 38 |
| Switzerland | 173 | 30 |
| Costa Rica | 93 | 60 |
| Bahrain | 145 | 90 |
| Gambia | 28 | 33 |
| Liberia | 135 | 36 |
| Angola | 76 | 28 |
| Armenia | 148 | 31 |
| Gabon | 154 | 34 |
| Hungary | 84 | 29 |
| Guinea | 68 | 35 |
| Serbia | 29 | 32 |
| Burundi | 119 | 37 |
| South Sudan | 177 | 30 |
| Maldives | 159 | 200 |
| Albania | 155 | 80 |
| Guinea-Bissau | 130 | 80 |
| Sierra Leone | 115 | 33 |
| Azerbaijan | 35 | 36 |
| Slovakia | 141 | 28 |
| Macedonia | 183 | 31 |
| Togo | 99 | 34 |
| Lebanon | 153 | 170 |
| Hong Kong | 14 | 29 |
| Uzbekistan | 40 | 35 |
| Bosnia and Herzegovina | 108 | 32 |
| Lithuania | 44 | 38 |
| Mauritania | 114 | 30 |
| Cape Verde | 186 | 60 |
| Iran | 57 | 33 |
| Lesotho | 136 | 60 |
| Mali | 69 | 36 |
| Malawi | 137 | 28 |
| Cyprus | 77 | 31 |
| CAF (Central African Republic) | 125 | 34 |
| Zimbabwe | 96 | 80 |
| Turkmenistan | 161 | 29 |
| Rwanda | 140 | 80 |
| Sudan | 1010 | 90 |
| Reunion | 146 | 60 |
| Oman | 107 | 80 |
| Bhutan | 158 | 35 |
| China | 3 | 32 |
| Barbados | 118 | 37 |
| Martinique | 1011 | 30 |
| Puerto Rico | 97 | 60 |
| Guadeloupe | 160 | 33 |
| Luxembourg | 165 | 36 |
| Antigua and Barbuda | 169 | 28 |
| Djibouti | 168 | 31 |
| French Guiana | 162 | 34 |
| Saint Lucia | 164 | 29 |
| Montenegro | 171 | 80 |
| Bahamas | 122 | 70 |
| Grenada | 127 | 90 |
| Brunei Darussalam | 121 | 170 |
| Cayman islands | 170 | 35 |
| Saint Vincent (Saint Vincent and the Grenadines) | 166 | 32 |
| Saint Kitts and Nevis | 134 | 38 |
| Aruba | 179 | 30 |
| Comoros | 133 | 80 |
| Malta | 199 | 33 |
| Singapore | 196 | 36 |
| Anguilla | 181 | 80 |
| Sao Tome and Principe | 178 | 28 |
| Palestine | 188 | 31 |
| Monaco | 144 | 34 |
| Belize | 124 | 70 |
| New Caledonia | 185 | 29 |
| Seychelles | 184 | 35 |
| Montserrat | 180 | 32 |
| Dominica | 126 | 37 |
| Korea | 1002 | 30 |
| Macau | 20 | 120 |
| Iceland | 132 | 100 |
| Eritrea | 176 | 33 |
| Kosovo | 1004 | 36 |
`;

function parseFacebookRows(tableText) {
    const rows = [];
    const regex = /\|\s*[^|]+\|\s*(\d+)\s*\|\s*(\d+)\s*\|/g;
    let match;
    while ((match = regex.exec(tableText)) !== null) {
        rows.push({ countryId: Number(match[1]), price: Number(match[2]) });
    }
    return rows;
}

function parsePrices(text) {
    return (text.match(/\b\d+\b/g) || []).map((value) => Number(value));
}

function valuesSql(name, apiCode, rows) {
    return rows.map((row) => `('${name}', '${apiCode}', ${row.countryId}, ${row.price}, 100, true)`).join(',\n');
}

function buildInsert(name, apiCode, rows) {
    return `INSERT INTO services (name, api_code, country_id, price, number_available, is_active)\nVALUES\n${valuesSql(name, apiCode, rows)}\nON CONFLICT (api_code, country_id) DO NOTHING;`;
}

const snapchatPrices = parsePrices(snapchatPricesRaw);
if (snapchatCountryIds.length !== snapchatPrices.length) {
    throw new Error(`Snapchat data mismatch: ${snapchatCountryIds.length} IDs vs ${snapchatPrices.length} prices`);
}

const snapchatRows = snapchatCountryIds.map((countryId, index) => ({
    countryId,
    price: snapchatPrices[index]
}));

const facebookRows = parseFacebookRows(facebookTable);

if (instagramRows.length !== 34) {
    throw new Error(`Unexpected Instagram row count: ${instagramRows.length}`);
}
if (!facebookRows.length) {
    throw new Error('Facebook rows could not be parsed');
}

const sql = `-- Generated on ${new Date().toISOString()}\nBEGIN;\n\n-- Payment schema migration\nALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS sender_name TEXT;\nALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;\nUPDATE payment_requests SET sender_name = LOWER(TRIM(sender_name)) WHERE sender_name IS NOT NULL;\nCREATE INDEX IF NOT EXISTS idx_payment_requests_pending_sender_amount\n    ON payment_requests (LOWER(sender_name), amount)\n    WHERE status = 'pending';\n\nDO $$\nBEGIN\n    IF EXISTS (\n        SELECT 1 FROM information_schema.tables\n        WHERE table_schema = 'public' AND table_name = 'payments'\n    ) THEN\n        EXECUTE 'ALTER TABLE payments ADD COLUMN IF NOT EXISTS sender_name TEXT';\n        EXECUTE 'ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ';\n        EXECUTE 'UPDATE payments SET sender_name = LOWER(TRIM(sender_name)) WHERE sender_name IS NOT NULL';\n        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payments_pending_sender_amount ON payments (LOWER(sender_name), amount) WHERE status = ''pending''';\n    END IF;\nEND $$;\n\n-- Create services table if missing\nCREATE TABLE IF NOT EXISTS services (\n    id SERIAL PRIMARY KEY,\n    name TEXT NOT NULL,\n    api_code TEXT NOT NULL,\n    country_id INTEGER NOT NULL,\n    price NUMERIC(12,2) NOT NULL,\n    number_available INTEGER DEFAULT 100,\n    is_active BOOLEAN DEFAULT TRUE,\n    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP\n);\n\n-- Ensure one service-country pair per platform\nDELETE FROM services s\nUSING (\n    SELECT id, ROW_NUMBER() OVER (PARTITION BY api_code, country_id ORDER BY id) AS rn\n    FROM services\n) d\nWHERE s.id = d.id\n  AND d.rn > 1;\n\nCREATE UNIQUE INDEX IF NOT EXISTS services_api_code_country_id_uidx\n    ON services (api_code, country_id);\n\n-- Instagram seeds\n${buildInsert('Instagram', 'ig', instagramRows)}\n\n-- Snapchat seeds\n${buildInsert('Snapchat', 'fu', snapchatRows)}\n\n-- Facebook seeds\n${buildInsert('Facebook', 'fb', facebookRows)}\n\nCOMMIT;\n`;

const outPath = path.join(process.cwd(), 'sql', '20260409_sender_name_and_service_seeds.sql');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, sql, 'utf8');

console.log(`Wrote ${outPath}`);
console.log(`Instagram rows: ${instagramRows.length}`);
console.log(`Snapchat rows: ${snapchatRows.length}`);
console.log(`Facebook rows: ${facebookRows.length}`);
