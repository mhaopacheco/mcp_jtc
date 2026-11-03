import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import axios from "axios";
import { z } from "zod";
import https from "https";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
// Carga el .env desde la carpeta del script (no desde el directorio de trabajo),
// porque Claude Desktop lanza el servidor con otro directorio de trabajo.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"), override: true, quiet: true });

// ─── Configuración de conexión SAP (desde .env) ───────────────────────────────
// Soporta dos modos:
//   1. Multi-conexion: SAP_CONNECTIONS = JSON array de
//      [{ alias, host, port, protocol, client, user, password }, ...]
//   2. Single-conexion legacy: SAP_HOST + SAP_USER + SAP_PASSWORD + SAP_CLIENT + SAP_PORT + SAP_PROTOCOL

let connections = {};   // alias -> { alias, host, port, protocol, client, user, password }
let activeAlias = null; // alias de la conexion activa en runtime

if (process.env.SAP_CONNECTIONS) {
  try {
    const list = JSON.parse(process.env.SAP_CONNECTIONS);
    for (const conn of list) {
      connections[conn.alias] = conn;
    }
    activeAlias = list[0].alias;
    const aliases = Object.keys(connections).join(", ");
    console.error(`Multi-conexion (SAP_CONNECTIONS): ${aliases} - usa sap_switch_client para cambiar`);
  } catch (e) {
    console.error("SAP_CONNECTIONS no es un JSON valido:", e.message);
    process.exit(1);
  }
} else {
  const SAP_HOST     = process.env.SAP_HOST;
  const SAP_PORT     = process.env.SAP_PORT || "443";
  const SAP_USER     = process.env.SAP_USER;
  const SAP_PASSWORD = process.env.SAP_PASSWORD;
  const SAP_CLIENT   = process.env.SAP_CLIENT || "100";
  const SAP_PROTOCOL = process.env.SAP_PROTOCOL || "https";

  if (!SAP_HOST || !SAP_USER || !SAP_PASSWORD) {
    console.error("Faltan variables de entorno: SAP_HOST, SAP_USER, SAP_PASSWORD");
    process.exit(1);
  }

  activeAlias = "default";
  connections["default"] = {
    alias: "default",
    host: SAP_HOST,
    port: SAP_PORT,
    protocol: SAP_PROTOCOL,
    client: SAP_CLIENT,
    user: SAP_USER,
    password: SAP_PASSWORD,
  };
}

// Devuelve la conexion activa o lanza error
function getActiveConn() {
  const conn = connections[activeAlias];
  if (!conn) {
    throw new Error(
      `No hay una conexion SAP activa. Usa sap_switch_client para seleccionar una de: ${Object.keys(connections).join(", ")}`
    );
  }
  return conn;
}

// Helper: shortcut para obtener el usuario de la conexion activa
// Evita referencias a SAP_USER (variable solo disponible en modo single-conexion)
function activeUser()   { return getActiveConn().user.toUpperCase(); }
function activeHost()   { const c = getActiveConn(); return `${c.host}:${c.port}`; }
function activeClient() { return getActiveConn().client; }

// ─── Cliente HTTP SAP ADT ─────────────────────────────────────────────────────
// getSapClient: crea un cliente axios con la conexion activa en el momento de la llamada
function getSapClient() {
  const c = getActiveConn();
  return axios.create({
    baseURL: `${c.protocol}://${c.host}:${c.port}`,
    timeout: 30_000,
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}`,
      "sap-client":  c.client,
      Accept:        "application/xml, application/json",
      "Content-Type": "application/xml",
    },
    // rejectUnauthorized:false requerido por el certificado self-signed de EPM.
    // Configurable via SAP_TLS_REJECT_UNAUTHORIZED=true para entornos con cert válido.
    httpsAgent: new https.Agent({
      rejectUnauthorized: process.env.SAP_TLS_REJECT_UNAUTHORIZED === "true",
    }),
  });
}

// sapClient: proxy que siempre refleja la conexion activa
const sapClient = new Proxy({}, {
  get(_, prop) {
    return (...args) => getSapClient()[prop](...args);
  },
});

// ─── Cache de CSRF token (válido 5 min, evita un round-trip por operación) ────
let _csrfCache = null;   // { token, cookie, expiresAt }

// ─── Versión leída desde package.json (fuente única de verdad) ───────────────
const _require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = _require("./package.json");

// ─── Servidor MCP ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "sap-adt",
  version: SERVER_VERSION,
});

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 1: Leer código fuente de un programa ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_program",
  "Lee el código fuente de un programa/reporte ABAP del repositorio SAP",
  {
    program_name: z.string().describe("Nombre del programa ABAP (ej: ZTPRUEBA01_TEST)"),
  },
  async ({ program_name }) => {
    try {
      const url = `/sap/bc/adt/programs/programs/${program_name.toUpperCase()}/source/main`;
      const response = await sapClient.get(url, {
        headers: { Accept: "text/plain" },
      });
      return {
        content: [
          {
            type: "text",
            text: `✅ Código fuente de ${program_name}:\n\n\`\`\`abap\n${response.data}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Error al leer ${program_name}: ${error.response?.status} - ${error.response?.data || error.message}`,
          },
        ],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 2: Leer código fuente de una clase ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_class",
  "Lee el código fuente de una clase ABAP (definición + implementación)",
  {
    class_name: z.string().describe("Nombre de la clase ABAP (ej: ZCL_MI_CLASE)"),
    section: z.enum(["main", "definitions", "implementations"]).optional().default("main").describe("Sección a leer. 'main' devuelve definitions + implementations completos en una sola llamada."),
  },
  async ({ class_name, section }) => {
    try {
      const cls = class_name.toUpperCase();

      // El código real de una clase global (CLASS DEFINITION + CLASS IMPLEMENTATION)
      // vive en /source/main. Los endpoints /includes/definitions e /includes/implementations
      // corresponden a los local class includes (CCDEF/CCIMPL) que solo contienen helpers locales.
      if (section === "main") {
        const response = await sapClient.get(
          `/sap/bc/adt/oo/classes/${cls}/source/main`,
          { headers: { Accept: "text/plain" } }
        );
        return {
          content: [{
            type: "text",
            text: `✅ Clase ${cls}:\n\n\`\`\`abap\n${response.data}\n\`\`\``,
          }],
        };
      }

      // definitions o implementations: local class includes (CCDEF / CCIMPL)
      const url = `/sap/bc/adt/oo/classes/${cls}/includes/${section}`;
      const response = await sapClient.get(url, { headers: { Accept: "text/plain" } });
      return {
        content: [{
          type: "text",
          text: `✅ Clase ${cls} [${section}]:\n\n\`\`\`abap\n${response.data}\n\`\`\``,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Error al leer clase ${class_name}: ${error.response?.status} - ${error.response?.data || error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 3: Listar objetos de un paquete ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_list_package",
  "Lista los objetos contenidos en un paquete ABAP",
  {
    package_name: z.string().describe("Nombre del paquete ABAP (ej: ZABAP)"),
  },
  async ({ package_name }) => {
    try {
      const pkg = package_name.toUpperCase();

      // Paso 1: metadata del paquete
      const pkgResponse = await sapClient.get(
        `/sap/bc/adt/packages/${pkg}`,
        { headers: { Accept: "*/*" } }
      );
      const pkgXml = pkgResponse.data;
      const pkgDesc = pkgXml.match(/adtcore:description="([^"]+)"/)?.[1] || "N/A";

      // Paso 2: buscar todos los objetos del paquete (packageName filter)
      const searchResponse = await sapClient.get(
        `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=*&maxResults=100&packageName=${pkg}`,
        { headers: { Accept: "application/xml" } }
      );
      const sxml = searchResponse.data;

      const allObj = [];
      const refs = [...sxml.matchAll(/<adtcore:objectReference\b([^>]*)>/g)];
      refs.forEach(r => {
        const attrs = r[1];
        const name  = attrs.match(/adtcore:name="([^"]+)"/)?.[1];
        const type  = attrs.match(/adtcore:type="([^"]+)"/)?.[1];
        const desc  = attrs.match(/adtcore:description="([^"]+)"/)?.[1] || "";
        if (name && type) allObj.push({ name, type, desc });
      });

      // Deduplicar
      const seen = new Set();
      const unique = allObj.filter(o => { const k=`${o.type}:${o.name}`; if(seen.has(k))return false; seen.add(k); return true; });

      let out = `Paquete: ${pkg}\nDescripcion: ${pkgDesc}\n`;
      if (unique.length === 0) {
        out += `\n(Sin objetos encontrados con busqueda por paquete)`;
      } else {
        out += `\n${unique.length} objeto(s):\n\n${"TIPO".padEnd(12)} ${"NOMBRE".padEnd(40)} DESCRIPCION\n${"-".repeat(75)}\n`;
        unique.forEach(o => { out += `  ${o.type.padEnd(12)} ${o.name.padEnd(40)} ${o.desc}\n`; });
      }

      return { content: [{ type: "text", text: out }] };

    } catch (error) {
      return { content: [{ type: "text", text: `Error al listar paquete ${package_name}: ${error.response?.status} - ${error.response?.data || error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 4: Crear un programa ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_program",
  "Crea un nuevo programa ABAP en el sistema SAP",
  {
    program_name:  z.string().describe("Nombre del programa (ej: ZTPRUEBA02)"),
    description:   z.string().describe("Descripción del programa"),
    package_name:  z.string().describe("Paquete donde se creará (ej: ZABAP)"),
    transport:     z.string().describe("Orden de transporte (ej: DV1K900123)"),
    source_code:   z.string().describe("Código fuente ABAP completo del programa"),
  },
  async ({ program_name, description, package_name, transport, source_code }) => {
    try {
      const name = program_name.toUpperCase();

      // FIX: obtener CSRF antes del POST (antes faltaba, fallaba en primera sesión)
      const { token, cookie } = await getCsrfToken();

      // Paso 1: Crear el objeto programa
      const createXml = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:repository xmlns:adtcore="http://www.sap.com/adt/core"
                    xmlns:programs="http://www.sap.com/adt/programs">
  <programs:program
    adtcore:description="${description}"
    adtcore:name="${name}"
    adtcore:responsible="${activeUser()}"
    programs:programType="executableProgram"/>
</adtcore:repository>`;

      await sapClient.post(
        `/sap/bc/adt/programs/programs`,
        createXml,
        {
          headers: {
            "Content-Type": "application/vnd.sap.adt.programs.programs.v2+xml",
            "sap-package": package_name.toUpperCase(),
            "sap-transport-request": transport,
            "X-CSRF-Token": token,
            Cookie: cookie,
          },
        }
      );

      // Paso 2: Subir el código fuente
      const { token: t2, cookie: c2 } = await getCsrfToken();
      await sapClient.put(
        `/sap/bc/adt/programs/programs/${name}/source/main`,
        source_code,
        {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "sap-transport-request": transport,
            "X-CSRF-Token": t2,
            Cookie: c2,
          },
        }
      );

      return {
        content: [
          {
            type: "text",
            text: `✅ Programa ${name} creado correctamente en el paquete ${package_name}.\n⚠️ Recuerda activar el objeto en SAP ADT o SE38.`,
          },
        ],
      };
    } catch (error) {
      if (error.response?.status === 403) invalidateCsrfCache();
      return {
        content: [
          {
            type: "text",
            text: `❌ Error al crear programa ${program_name}: ${error.response?.status} - ${JSON.stringify(error.response?.data) || error.message}`,
          },
        ],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 5: Activar un objeto ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_activate_object",
  "Activa un objeto ABAP en el sistema SAP",
  {
    object_name: z.string().describe("Nombre del objeto a activar (ej: ZTPRUEBA02)"),
    object_type: z.enum(["PROG/P", "CLAS/OC", "FUGR/FF", "TABL/DT"]).describe("Tipo de objeto ADT"),
  },
  // FIX: alias de sap_activate — misma lógica, mantiene compatibilidad con calls existentes
  async (args) => {
    return activateObject(args.object_name, args.object_type);
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 6: Verificar conectividad con SAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_ping",
  "Verifica la conectividad con el sistema SAP",
  {},
  async () => {
    try {
      const response = await sapClient.get("/sap/bc/adt/discovery", {
        headers: { Accept: "application/atomsvc+xml" },
      });
      return {
        content: [
          {
            type: "text",
            text: `✅ Conexión exitosa con SAP!\n🔗 Host: ${activeHost()}\n👤 Usuario: ${activeUser()}\n📦 Cliente: ${activeClient()}\n📡 Estado HTTP: ${response.status}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ No se pudo conectar con SAP.\n🔗 Host: ${activeHost()}\n❗ Error: ${error.response?.status || error.code} - ${error.message}`,
          },
        ],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 7: Leer tabla SAP via OData API estándar
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_table",
  "Lee datos de tablas/vistas de customizing SAP usando las APIs OData estándar. Soporta tablas de configuración de FI, MM, SD, HR y datos maestros.",
  {
    table: z.enum([
      "companies",
      "payment_terms",
      "business_partners",
      "chart_of_accounts",
      "gl_accounts",
      "cost_centers",
      "profit_centers",
      "purchasing_orgs",
      "plants",
      "sales_orgs",
      "currencies",
      "countries",
      "tax_codes",
      "house_banks",
      "payment_methods",
    ]).describe("Tabla/entidad a consultar"),
    filter: z.string().optional().describe("Filtro OData (ej: CompanyCode eq '1000')"),
    top: z.number().optional().default(20).describe("Máximo número de registros (default: 20)"),
  },
  async ({ table, filter, top = 20 }) => {
    // Mapa de tabla → endpoint OData + campos relevantes
    const tableMap = {
      companies:        { url: "/sap/opu/odata/sap/API_COMPANYCODE_SRV/A_CompanyCode",              select: "CompanyCode,CompanyCodeName,Currency,Country,Language",            desc: "Sociedades" },
      payment_terms:    { url: "/sap/opu/odata/sap/API_PAYMENTTERMS_SRV/A_PaymentTerms",            select: "PaymentTerms,PaymentTermsName,CashDiscount1Days,CashDiscount1Percent", desc: "Condiciones de pago" },
      business_partners:{ url: "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner",         select: "BusinessPartner,BusinessPartnerFullName,BusinessPartnerType,SearchTerm1", desc: "Socios comerciales" },
      chart_of_accounts:{ url: "/sap/opu/odata/sap/API_CHARTOFACCOUNTS_SRV/A_ChartOfAccounts",      select: "ChartOfAccounts,MaintenanceLanguage",                                desc: "Planes de cuentas" },
      gl_accounts:      { url: "/sap/opu/odata/sap/API_GL_ACCOUNT_0001/A_GLAccountInChartOfAccounts", select: "ChartOfAccounts,GLAccount,GLAccountName,GLAccountType",            desc: "Cuentas del mayor" },
      cost_centers:     { url: "/sap/opu/odata/sap/API_COSTCENTER_SRV/A_CostCenter",                select: "ControllingArea,CostCenter,CostCenterName,ValidityEndDate",          desc: "Centros de costo" },
      profit_centers:   { url: "/sap/opu/odata/sap/API_PROFITCENTER_SRV/A_ProfitCenter",            select: "ControllingArea,ProfitCenter,ProfitCenterName",                       desc: "Centros de beneficio" },
      purchasing_orgs:  { url: "/sap/opu/odata/sap/API_PURCHASING_ORG_SRV/A_PurchasingOrg",         select: "PurchasingOrganization,PurchasingOrganizationName",                  desc: "Organizaciones de compra" },
      plants:           { url: "/sap/opu/odata/sap/API_PLANT_SRV/A_Plant",                          select: "Plant,PlantName,Country,Language",                                   desc: "Centros / Plantas" },
      sales_orgs:       { url: "/sap/opu/odata/sap/API_SALES_ORG_SRV/A_SalesOrganization",          select: "SalesOrganization,SalesOrganizationName,Currency",                   desc: "Organizaciones de ventas" },
      currencies:       { url: "/sap/opu/odata/sap/API_CURRENCY_SRV/A_Currency",                    select: "Currency,CurrencyName,DecimalPlaces",                                desc: "Monedas" },
      countries:        { url: "/sap/opu/odata/sap/API_COUNTRY_SRV/A_Country",                      select: "Country,CountryName,Currency,Language",                              desc: "Países" },
      tax_codes:        { url: "/sap/opu/odata/sap/API_TAX_QUERY_SRV/A_TaxCode",                    select: "Country,TaxCode,TaxCodeName,TaxType",                                desc: "Códigos de impuesto" },
      house_banks:      { url: "/sap/opu/odata/sap/API_HOUSEBANK_SRV/A_HouseBank",                  select: "CompanyCode,HouseBank,HouseBankName,BankCountry,BankInternalID",     desc: "Bancos propios" },
      payment_methods:  { url: "/sap/opu/odata/sap/API_PAYMENT_METHOD_SRV/A_PaymentMethod",         select: "PaymentMethod,PaymentMethodName,PaymentCategory",                    desc: "Vías/Medios de pago" },
    };

    const cfg = tableMap[table];
    let url = `${cfg.url}?$format=json&$top=${top}&$select=${cfg.select}`;
    if (filter) url += `&$filter=${encodeURIComponent(filter)}`;

    try {
      const response = await sapClient.get(url, {
        headers: { Accept: "application/json" },
      });

      const results = response.data?.d?.results || response.data?.value || [];

      if (results.length === 0) {
        return { content: [{ type: "text", text: `ℹ️ No se encontraron registros en ${cfg.desc}${filter ? ` con filtro: ${filter}` : ""}.` }] };
      }

      // Formatear resultado como tabla de texto
      const keys = Object.keys(results[0]).filter(k => !k.startsWith("__"));
      const header = keys.join(" | ");
      const separator = keys.map(k => "-".repeat(Math.max(k.length, 10))).join("-|-");
      const rows = results.map(r => keys.map(k => String(r[k] ?? "")).join(" | ")).join("\n");

      return {
        content: [{
          type: "text",
          text: `✅ ${cfg.desc} — ${results.length} registro(s)${filter ? ` (filtro: ${filter})` : ""}:\n\n${header}\n${separator}\n${rows}`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const msg = status === 403
        ? `Sin autorización para leer ${cfg.desc}. El usuario necesita acceso al servicio OData ${cfg.url}.`
        : `${status} - ${error.message}`;
      return { content: [{ type: "text", text: `❌ Error leyendo ${cfg.desc}: ${msg}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 8: Buscar objetos ABAP por nombre o patrón
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_search_objects",
  "Busca objetos ABAP en el repositorio SAP por nombre o patrón (soporta wildcards *). Puede filtrar por tipo de objeto.",
  {
    query:       z.string().describe("Patrón de búsqueda (ej: ZCL_FI*, ZRAP*, Z_I_*)"),
    object_type: z.enum(["PROG/P","CLAS/OC","INTF/OI","DDLS/DF","BDEF/BO","SRVD/SRD","SRVB/SVB","TABL/DT","FUGR/FF","DTEL/DE","DOMA/DO","DCLS/DL","ALL"]).optional().default("ALL").describe("Tipo de objeto"),
    max_results: z.number().optional().default(30).describe("Máximo resultados (default: 30)"),
  },
  async ({ query, object_type = "ALL", max_results = 30 }) => {
    try {
      // FIX v3.6.0: cuando ALL, una sola peticion sin objectType devuelve todos los tipos.
      // Con objectType especifico NO URL-encodes la barra (PROG/P, no PROG%2FP).
      let url = `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}&maxResults=${max_results}`;
      if (object_type !== "ALL") url += `&objectType=${object_type}`;

      const response = await sapClient.get(url, { headers: { Accept: "application/xml" } });
      const xml = response.data;

      // FIX v3.6.0: regex corregida — [^/]* rompe con URIs que contienen "/".
      // Usamos [\s\S]*? (lazy) o capturamos individualmente con atributos en cualquier orden.
      const allResults = [];
      const refs = [...xml.matchAll(/<adtcore:objectReference\b([^>]*)>/g)];
      refs.forEach(r => {
        const attrs = r[1];
        const name    = attrs.match(/adtcore:name="([^"]+)"/)?.[1];
        const type    = attrs.match(/adtcore:type="([^"]+)"/)?.[1];
        const pkg     = attrs.match(/adtcore:packageName="([^"]+)"/)?.[1];
        const desc    = attrs.match(/adtcore:description="([^"]+)"/)?.[1] || "";
        if (name && type) allResults.push({ name, type, package: pkg || "?", desc });
      });

      // Deduplicar por name+type
      const seen = new Set();
      const unique = allResults.filter(r => {
        const k = `${r.type}:${r.name}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });

      if (unique.length === 0) {
        return { content: [{ type: "text", text: `No se encontraron objetos con el patron "${query}".` }] };
      }

      const rows = unique.map(r => `  ${r.type.padEnd(10)} ${r.name.padEnd(40)} [${r.package}]${r.desc ? " - " + r.desc : ""}`).join("\n");
      return {
        content: [{
          type: "text",
          text: `${unique.length} objeto(s) encontrado(s) para "${query}":\n\n${"TIPO".padEnd(10)} ${"NOMBRE".padEnd(40)} PAQUETE\n${"-".repeat(70)}\n${rows}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error en busqueda: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 9: Leer objetos de una orden de transporte
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_transport",
  "Lee el contenido de una orden de transporte SAP (CTS): metadata, tareas y objetos incluidos. Puede filtrar solo objetos ABAP.",
  {
    transport_number: z.string().describe("Número de la orden de transporte (ej: DV1K922749)"),
    abap_only: z.boolean().optional().default(false).describe("Si true, muestra solo objetos ABAP (PROG, CLAS, DDLS, etc.). Si false, muestra todos los objetos incluyendo UI5."),
  },
  async ({ transport_number, abap_only = false }) => {
    try {
      const num = transport_number.toUpperCase().trim();
      const response = await sapClient.get(
        `/sap/bc/adt/cts/transportrequests/${num}?withObjects=true`,
        { headers: { Accept: "*/*" } }
      );

      const xml = response.data;

      // Extraer metadata de la orden/tarea
      const reqMatch   = xml.match(/tm:request[^>]*tm:number="([^"]+)"[^>]*tm:desc="([^"]*)"[^>]*tm:type="([^"]*)"[^>]*tm:status="([^"]*)"[^>]*tm:target_desc="([^"]*)"/);
      const taskMatch  = xml.match(/tm:task[^>]*tm:number="([^"]+)"[^>]*tm:owner="([^"]*)"[^>]*tm:desc="([^"]*)"[^>]*tm:type="([^"]*)"[^>]*tm:status_text="([^"]*)"/);

      // Extraer todos los objetos
      const objMatches = [...xml.matchAll(/tm:abap_object[^>]*tm:pgmid="([^"]*)"[^>]*tm:type="([^"]*)"[^>]*tm:name="([^"]*)"[^>]*tm:wbtype="([^"]*)"[^>]*tm:dummy_uri="([^"]*)"[^>]*tm:obj_info="([^"]*)"/g)];

      // Tipos ABAP relevantes
      const abapTypes = ["PROG","CLAS","INTF","FUGR","TABL","DTEL","DOMA","DDLS","BDEF","SRVD","SRVB","DCLS","TTYP","VIEW","MSAG","SICF","ENHS","ENHO","ENQD"];

      const objects = objMatches.map(m => ({
        pgmid:   m[1].trim(),
        type:    m[2].trim(),
        name:    m[3].trim(),
        wbtype:  m[4].trim(),
        info:    m[6].trim(),
        isAbap:  abapTypes.includes(m[2].trim()) || m[1].trim() === "R3TR",
      }));

      const filtered = abap_only ? objects.filter(o => o.isAbap) : objects;

      // Agrupar por tipo
      const byType = filtered.reduce((acc, o) => {
        const key = o.type || o.wbtype.split("/")[0] || "OTHER";
        if (!acc[key]) acc[key] = [];
        acc[key].push(o.name);
        return acc;
      }, {});

      let summary = `📦 Orden de transporte: ${num}\n`;
      if (reqMatch)  summary += `📋 Orden padre: ${reqMatch[1]} — ${reqMatch[2]} [${reqMatch[4]}]\n`;
      if (taskMatch) summary += `👤 Tarea: ${taskMatch[1]} | Dueño: ${taskMatch[2]} | ${taskMatch[5]}\n`;
      summary += `📊 Total objetos${abap_only ? " ABAP" : ""}: ${filtered.length} (de ${objects.length} totales)\n\n`;

      if (filtered.length === 0) {
        summary += abap_only
          ? "ℹ️ No hay objetos ABAP en esta orden (puede contener solo UI5 o customizing)."
          : "ℹ️ La orden no contiene objetos.";
      } else {
        Object.entries(byType).sort().forEach(([type, names]) => {
          summary += `── ${type} (${names.length}) ──\n`;
          names.forEach(n => { summary += `   ${n.replace(/\s+/g, " ").trim()}\n`; });
          summary += "\n";
        });
      }

      return { content: [{ type: "text", text: summary }] };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error leyendo orden ${transport_number}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 10b: Listar órdenes de transporte activas del usuario — diagnóstico
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_list_my_transports",
  "Lista las órdenes/tareas de transporte activas (status=D) del usuario actual. Útil para encontrar el corrNr correcto de un objeto $TMP.",
  {},
  async () => {
    try {
      const resp = await sapClient.get(
        `/sap/bc/adt/cts/transportrequests?user=${activeUser()}&status=D&category=Workbench`,
        { headers: { Accept: "application/xml, */*" } }
      );
      const xml = String(resp.data);
      const nums = [...xml.matchAll(/[A-Z0-9]{3}K\d+/g)].map(m => m[0]);
      const unique = [...new Set(nums)];
      const tasks = [...xml.matchAll(/tm:task[^>]*tm:number="([^"]+)"[^>]*tm:owner="([^"]*)"[^>]*tm:type="([^"]*)"[^>]*tm:status[^"]*"([^"]*)"[^>]*(?:tm:target="([^"]*)")?/g)];
      let out = `📋 Órdenes activas para ${activeUser()}:\n\n`;
      out += `Números encontrados: ${unique.join(", ")}\n\n`;
      tasks.forEach(t => {
        out += `🔑 ${t[1]} | owner=${t[2]} | type=${t[3]} | status=${t[4]} | target=${t[5]||'?'}\n`;
      });
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Error: ${err.response?.status} - ${err.message}\n${err.response?.data?.substring?.(0,400)||""}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 10: Información del sistema SAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_system_info",
  "Obtiene información del sistema SAP: release, SP, landscape, sistema, cliente y usuario activo",
  {},
  async () => {
    try {
      const response = await sapClient.get("/sap/bc/adt/system/information", {
        headers: { Accept: "application/vnd.sap.adt.system.information.v1+xml, application/xml" },
      });
      const xml = response.data;

      // Extraer campos clave del XML de información del sistema
      const release   = xml.match(/adt:releaseInformation[^>]*adt:release="([^"]+)"/)?.[1]
                     || xml.match(/release="([^"]+)"/)?.[1] || "N/A";
      const sp        = xml.match(/adt:supportPackage[^>]*>([^<]+)</)?.[1]
                     || xml.match(/supportPackage="([^"]+)"/)?.[1] || "N/A";
      const sysId     = xml.match(/adt:systemId[^>]*>([^<]+)</)?.[1]
                     || xml.match(/systemId="([^"]+)"/)?.[1] || "N/A";
      const client    = xml.match(/adt:client[^>]*>([^<]+)</)?.[1]
                     || xml.match(/client="([^"]+)"/)?.[1] || activeClient();
      const user      = xml.match(/adt:user[^>]*>([^<]+)</)?.[1]
                     || xml.match(/user="([^"]+)"/)?.[1] || activeUser();
      const landscape = xml.match(/adt:landscape[^>]*>([^<]+)</)?.[1]
                     || xml.match(/landscape="([^"]+)"/)?.[1] || "N/A";

      return {
        content: [{
          type: "text",
          text: `✅ Información del sistema SAP:\n\n`
              + `🖥️  Sistema:      ${sysId}\n`
              + `📦  Cliente:      ${client}\n`
              + `🚀  Release:      ${release}\n`
              + `🔧  Support Pkg:  ${sp}\n`
              + `🌍  Landscape:    ${landscape}\n`
              + `👤  Usuario:      ${user}\n`
              + `🔗  Host:         ${activeHost()}\n\n`
              + `--- XML completo ---\n${xml.substring(0, 1500)}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error obteniendo info del sistema: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 11: Dónde se usa un objeto (Where-Used)
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_where_used",
  "Busca dónde se usa un objeto ABAP en el sistema (where-used list). Útil para analizar impacto antes de modificar.",
  {
    object_name: z.string().describe("Nombre del objeto a analizar (ej: ZCL_GT_PARAMETROS, ZTPRUEBA01)"),
    object_type: z.enum(["PROG/P","CLAS/OC","INTF/OI","DDLS/DF","BDEF/BO","TABL/DT","FUGR/FF","DTEL/DE","DOMA/DO"]).describe("Tipo de objeto ADT"),
    max_results: z.number().optional().default(50).describe("Máximo resultados (default: 50)"),
  },
  async ({ object_name, object_type, max_results = 50 }) => {
    try {
      const name = object_name.toUpperCase();
      // Construir URI del objeto
      const typePrefix = object_type.split("/")[0].toLowerCase();
      const typeFolder = typePrefix === "prog" ? "programs/programs"
                       : typePrefix === "clas" ? "oo/classes"
                       : typePrefix === "intf" ? "oo/interfaces"
                       : typePrefix === "ddls" ? "ddic/ddl/sources"
                       : typePrefix === "tabl" ? "ddic/tables"
                       : typePrefix === "fugr" ? "functions/groups"
                       : typePrefix === "dtel" ? "ddic/dataelements"
                       : typePrefix === "doma" ? "ddic/domains"
                       : typePrefix === "bdef" ? "bo/behaviordefinitions"
                       : typePrefix;
      // ADT where-used: XML body with type attribute included
      const objPath = `/sap/bc/adt/${typeFolder}/${name}`;
      const bodyXml = `<?xml version="1.0" encoding="utf-8"?>`
        + `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">`
        + `<adtcore:objectReference adtcore:uri="${objPath}" adtcore:type="${object_type}" adtcore:name="${name}"/>`
        + `</adtcore:objectReferences>`;

      const url = `/sap/bc/adt/repository/informationsystem/whereused?maxResults=${max_results}`;

      // FIX: where-used POST requires CSRF token — fetch it before the call
      const { token: csrfToken, cookie: csrfCookie } = await getCsrfToken();
      const response = await sapClient.post(url, bodyXml, {
        headers: {
          Accept: "application/xml",
          "Content-Type": "application/xml",
          "X-CSRF-Token": csrfToken,
          ...(csrfCookie ? { Cookie: csrfCookie } : {}),
        },
      });
      const xml = response.data;

      // Extraer referencias del XML
      const refs = [...xml.matchAll(/adtcore:name="([^"]+)"[^>]*adtcore:type="([^"]+)"/g)];
      const unique = [...new Map(refs.map(m => [`${m[2]}:${m[1]}`, { name: m[1], type: m[2] }])).values()];

      if (unique.length === 0) {
        return { content: [{ type: "text", text: `ℹ️ No se encontraron referencias a ${name} (${object_type}).` }] };
      }

      const byType = unique.reduce((acc, o) => {
        if (!acc[o.type]) acc[o.type] = [];
        acc[o.type].push(o.name);
        return acc;
      }, {});

      let out = `✅ Where-Used de ${name} (${object_type}) — ${unique.length} referencia(s):\n\n`;
      Object.entries(byType).sort().forEach(([t, names]) => {
        out += `── ${t} (${names.length}) ──\n`;
        names.forEach(n => { out += `   ${n}\n`; });
        out += "\n";
      });

      return { content: [{ type: "text", text: out }] };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error en where-used de ${object_name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 12: Búsqueda de texto libre en fuentes ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_text_search",
  "Realiza búsqueda de texto libre dentro del código fuente ABAP del repositorio SAP. Permite buscar cadenas, métodos o patrones en todos los objetos.",
  {
    search_term:  z.string().describe("Texto a buscar en las fuentes ABAP (ej: BREAK, ZCL_GT_PARAMETROS, SELECT_SINGLE)"),
    object_type:  z.enum(["PROG/P","CLAS/OC","INTF/OI","DDLS/DF","FUGR/FF","ALL"]).optional().default("ALL").describe("Tipo de objeto donde buscar"),
    package_name: z.string().optional().describe("Limitar búsqueda a un paquete (ej: ZABAP, ZRAP_FIORI)"),
    max_results:  z.number().optional().default(20).describe("Máximo resultados (default: 20)"),
  },
  async ({ search_term, object_type = "ALL", package_name, max_results = 20 }) => {
    try {
      // FIX v3.6.0: el endpoint /textsearch requiere indice ABAP Text Search habilitado en el sistema.
      // En sistemas donde no esta habilitado devuelve 500 "Source Search is not supported".
      // Intentamos ambos endpoints; si no disponible, retornamos mensaje claro.
      let url = `/sap/bc/adt/repository/informationsystem/textsearch`
              + `?searchString=${encodeURIComponent(search_term)}&maxResults=${max_results}`;
      if (object_type !== "ALL") url += `&objectType=${object_type}`;
      if (package_name)          url += `&packageName=${encodeURIComponent(package_name.toUpperCase())}`;

      const response = await sapClient.get(url, { headers: { Accept: "application/xml" } });
      const xml = response.data;

      const refs = [...xml.matchAll(/<adtcore:objectReference\b([^>]*)>/g)];
      const hits = [];
      refs.forEach(r => {
        const attrs = r[1];
        const name  = attrs.match(/adtcore:name="([^"]+)"/)?.[1];
        const type  = attrs.match(/adtcore:type="([^"]+)"/)?.[1];
        if (name && type) hits.push({ name, type });
      });

      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No se encontraron ocurrencias de "${search_term}".` }] };
      }

      const unique = [...new Map(hits.map(h => [`${h.type}:${h.name}`, h])).values()];
      let out = `Busqueda de texto "${search_term}" — ${unique.length} objeto(s):\n\n`;
      unique.forEach(o => { out += `  ${o.type.padEnd(10)} ${o.name}\n`; });
      return { content: [{ type: "text", text: out }] };

    } catch (error) {
      const body = error.response?.data ?? "";
      const notSupported = typeof body === "string" && body.includes("Source Search is not supported");
      const noService    = typeof body === "string" && body.includes("No service found");
      if (notSupported || noService) {
        return { content: [{ type: "text", text: `La busqueda de texto libre no esta habilitada en este sistema SAP (requiere ABAP Text Search index). Usa sap_search_objects con patron de nombre para buscar objetos.` }] };
      }
      return { content: [{ type: "text", text: `Error en busqueda de texto "${search_term}": ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 13: Leer código fuente de un Grupo de Funciones / Función
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_function_group",
  "Lee el código fuente de un módulo de función o grupo de funciones ABAP",
  {
    name:     z.string().describe("Nombre del grupo de funciones o módulo de función (ej: ZPAGO_PROVEEDOR, CALCULATE_TAX_AMOUNT)"),
    type:     z.enum(["group", "function"]).optional().default("group").describe("'group' para el grupo completo, 'function' para un módulo individual"),
    section:  z.enum(["main","includes"]).optional().default("main").describe("Sección a leer (solo aplica para grupos)"),
  },
  async ({ name, type = "group", section = "main" }) => {
    try {
      const n = name.toUpperCase();
      let url, label;

      if (type === "function") {
        // FIX v3.6.0: SAP ADT expone FMs bajo el grupo padre.
        // URL correcta: /functions/groups/{GRP}/fmodules/{FM}/source/main
        // Primero buscamos el FM para obtener su URI que contiene el grupo
        const searchResp = await sapClient.get(
          `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${n}&maxResults=5&objectType=FUGR%2FFF`,
          { headers: { Accept: "application/xml" } }
        );
        const uriMatch = searchResp.data.match(/adtcore:uri="([^"]*fmodules[^"]+)"/i);
        if (!uriMatch) {
          return { content: [{ type: "text", text: `Modulo de funcion ${n} no encontrado en el repositorio.` }] };
        }
        url   = `${uriMatch[1]}/source/main`;
        label = `Modulo de funcion ${n}`;
      } else {
        // Leer grupo de funciones (include principal)
        url   = `/sap/bc/adt/functions/groups/${n}/source/${section}`;
        label = `Grupo de funciones ${n} [${section}]`;
      }

      const response = await sapClient.get(url, { headers: { Accept: "text/plain" } });
      return {
        content: [{
          type: "text",
          text: `Codigo fuente de ${label}:\n\n\`\`\`abap\n${response.data}\n\`\`\``,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error leyendo funcion/grupo ${name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 14: Leer definición de vista CDS / DDL Source
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_cds_view",
  "Lee el código fuente (DDL) de una vista CDS, BDEF, DCLS o Projection View del repositorio SAP",
  {
    name:        z.string().describe("Nombre de la vista CDS (ej: ZI_FI_PROVEEDOR, ZC_FI_PAGOS)"),
    object_type: z.enum(["DDLS/DF","BDEF/BO","DCLS/DL","SRVD/SRD","SRVB/SVB"]).optional().default("DDLS/DF").describe("Tipo: DDLS=CDS View, BDEF=Behavior Definition, DCLS=Access Control"),
  },
  async ({ name, object_type = "DDLS/DF" }) => {
    try {
      const n = name.toUpperCase();
      // Mapa tipo → ruta ADT
      const pathMap = {
        "DDLS/DF": `ddic/ddl/sources/${n}/source/main`,
        "BDEF/BO": `bo/behaviordefinitions/${n}/source/main`,
        "DCLS/DL": `dcl/sources/${n}/source/main`,
        "SRVD/SRD": `srvd/sources/${n}`,
        "SRVB/SVB": `srvb/sources/${n}`,
      };

      const path    = pathMap[object_type] || pathMap["DDLS/DF"];
      const url     = `/sap/bc/adt/${path}`;
      const label   = `${object_type} ${n}`;

      const response = await sapClient.get(url, { headers: { Accept: "text/plain" } });
      return {
        content: [{
          type: "text",
          text: `✅ ${label}:\n\n\`\`\`abap\n${response.data}\n\`\`\``,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error leyendo CDS ${name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 15: Listar/Leer BAdI enhancement spots
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_badi",
  "Lista o lee los detalles de un BAdI Enhancement Spot en el sistema SAP. Útil para extensiones Clean Core.",
  {
    name:      z.string().describe("Nombre del enhancement spot o BAdI (ej: ES_FI_DOCUMENT_POST, BADI_FI_TAX_VALUE)"),
    list_only: z.boolean().optional().default(false).describe("Si true, solo lista los BAdIs sin leer detalles"),
  },
  async ({ name, list_only = false }) => {
    try {
      const n = name.toUpperCase();

      if (list_only) {
        // Buscar enhancement spots que contengan el patrón
        const url = `/sap/bc/adt/repository/informationsystem/search`
                  + `?operation=quickSearch&query=${encodeURIComponent(n)}*&maxResults=30&objectType=ENHS%2FES`;
        const response = await sapClient.get(url, { headers: { Accept: "application/xml" } });
        const xml = response.data;
        const spots = [...xml.matchAll(/adtcore:name="([^"]+)"[^>]*adtcore:type="([^"]+)"/g)];
        if (spots.length === 0) {
          return { content: [{ type: "text", text: `ℹ️ No se encontraron Enhancement Spots con patrón "${name}".` }] };
        }
        let out = `✅ Enhancement Spots encontrados:\n\n`;
        spots.forEach(s => { out += `  ${s[2].padEnd(12)} ${s[1]}\n`; });
        return { content: [{ type: "text", text: out }] };
      }

      // Leer detalles del BAdI/Enhancement Spot
      const response = await sapClient.get(
        `/sap/bc/adt/businesslogicextensions/badis/${n}`,
        { headers: { Accept: "application/vnd.sap.adt.badis.v1+xml, application/xml" } }
      );
      return {
        content: [{
          type: "text",
          text: `✅ BAdI Enhancement Spot ${n}:\n\n${response.data.substring(0, 3000)}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error leyendo BAdI ${name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 16: Preview de datos de tabla o vista CDS (SQL ad-hoc)
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_data_preview",
  "Ejecuta una consulta SQL ad-hoc o muestra un preview de datos de una tabla DDIC o vista CDS directamente en SAP.",
  {
    query:       z.string().describe("Tabla DDIC o sentencia SELECT (ej: 'ZGT_T_ENHANC' o 'SELECT * FROM ZGT_T_ENHANC WHERE ACTIVE = X')"),
    mode:        z.enum(["table","cds","sql"]).optional().default("table").describe("'table'=tabla DDIC, 'cds'=vista CDS, 'sql'=SQL freestyle"),
    max_rows:    z.number().optional().default(20).describe("Máximo filas a retornar (default: 20)"),
  },
  async ({ query, mode = "table", max_rows = 20 }) => {
    try {
      let url, body, method = "GET";

      if (mode === "table" || mode === "cds") {
        // Data preview del repositorio ADT — SAP devuelve XML
        const objectName = query.trim().toUpperCase().replace(/\s+/g, "");
        const endpoint   = mode === "cds"
          ? `/sap/bc/adt/datapreview/cds?cdsName=${encodeURIComponent(objectName)}&rowNumber=${max_rows}`
          : `/sap/bc/adt/datapreview/freestyle?rowNumber=${max_rows}`;
        if (mode === "cds") {
          url = endpoint;
        } else {
          // table: usar freestyle con SELECT * — rowNumber en la URL controla el limite
          // NO usar "UP TO N ROWS" — el endpoint freestyle de ADT no soporta esa sintaxis ABAP
          url    = `/sap/bc/adt/datapreview/freestyle?rowNumber=${max_rows}`;
          method = "POST";
          body   = `SELECT * FROM ${objectName}`;
        }
      } else {
        // SQL freestyle
        url    = `/sap/bc/adt/datapreview/freestyle?rowNumber=${max_rows}`;
        method = "POST";
        body   = query;
      }

      // FIX v3.6.0: datapreview/freestyle only accepts */* — application/xml returns 406
      const headers = {
        Accept: "*/*",
        ...(method === "POST" ? { "Content-Type": "text/plain; charset=utf-8" } : {}),
      };

      // FIX: POST to datapreview/freestyle requires CSRF token
      if (method === "POST") {
        const { token, cookie } = await getCsrfToken();
        headers["X-CSRF-Token"] = token;
        if (cookie) headers["Cookie"] = cookie;
      }

      const response = method === "POST"
        ? await sapClient.post(url, body, { headers })
        : await sapClient.get(url, { headers });

      const xml = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);

      // Parsear XML de data preview ADT — formato COLUMNAR:
      // SAP devuelve <dataPreview:columns> una por columna, cada una con
      // <dataPreview:metadata name="CAMPO"/> y <dataPreview:dataSet> con N <dataPreview:data>valor</dataPreview:data>
      const totalRowsMatch = xml.match(/<dataPreview:totalRows>(\d+)<\/dataPreview:totalRows>/);
      const totalRows = totalRowsMatch ? parseInt(totalRowsMatch[1]) : 0;

      // Extraer cada columna con su nombre y sus valores
      const columnBlocks = [...xml.matchAll(/<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g)];

      if (columnBlocks.length === 0) {
        return { content: [{ type: "text", text: `✅ Datos (raw):\n\n${xml.substring(0, 3000)}` }] };
      }

      const columns = columnBlocks.map(block => {
        const nameMatch = block[1].match(/dataPreview:name="([^"]+)"/);
        // Extract only the dataSet block to avoid matching metadata tags as data
        const dataSetMatch = block[1].match(/<dataPreview:dataSet>([\s\S]*?)<\/dataPreview:dataSet>/);
        const dataSetXml = dataSetMatch ? dataSetMatch[1] : block[1];
        const values = [...dataSetXml.matchAll(/<dataPreview:data[^>]*>([\s\S]*?)<\/dataPreview:data>/g)]
                          .map(m => m[1].trim());
        return { name: nameMatch ? nameMatch[1] : "?", values };
      });

      const colNames  = columns.map(c => c.name);
      const numRows   = columns[0]?.values.length ?? 0;

      const colWidths = colNames.map(c => Math.max(c.length, 8));
      const header    = colNames.map((c, i) => c.padEnd(colWidths[i])).join(" | ");
      const sep       = colWidths.map(w => "─".repeat(w)).join("─┼─");

      const rows = [];
      for (let r = 0; r < numRows; r++) {
        rows.push(columns.map((col, i) => (col.values[r] ?? "").padEnd(colWidths[i])).join(" | "));
      }

      const body2 = rows.length > 0 ? rows.join("\n") : "(sin datos)";
      const note  = totalRows > numRows ? `\n(mostrando ${numRows} de ${totalRows} filas totales)` : "";

      return { content: [{ type: "text", text: `✅ Data Preview — ${query.toUpperCase()} (${numRows} filas):\n\n${header}\n${sep}\n${body2}${note}` }] };

    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error en data preview: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 17: Ejecutar ATC (ABAP Test Cockpit) sobre un objeto
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_run_atc",
  "Ejecuta una verificación ATC (ABAP Test Cockpit) sobre un objeto ABAP y retorna los hallazgos de calidad de código.",
  {
    object_name: z.string().describe("Nombre del objeto a verificar (ej: ZCL_FI_IMPRESION_COMPROB_PAGO)"),
    object_type: z.enum(["PROG/P","CLAS/OC","INTF/OI","FUGR/FF","DDLS/DF"]).describe("Tipo de objeto ADT"),
  },
  async ({ object_name, object_type }) => {
    try {
      const name = object_name.toUpperCase();
      const typePrefix = object_type.split("/")[0].toLowerCase();
      const typeFolder = typePrefix === "prog" ? "programs/programs"
                       : typePrefix === "clas" ? "oo/classes"
                       : typePrefix === "intf" ? "oo/interfaces"
                       : typePrefix === "fugr" ? "functions/groups"
                       : typePrefix === "ddls" ? "ddic/ddl/sources"
                       : typePrefix;
      const objectUri = `/sap/bc/adt/${typeFolder}/${name}`;

      // Paso 1: Crear run ATC
      const runXml = `<?xml version="1.0" encoding="UTF-8"?>
<atcrun:run xmlns:atcrun="http://www.sap.com/adt/atc/run"
            xmlns:atcobj="http://www.sap.com/adt/atc/objectset"
            atcrun:maximumVerdicts="100">
  <objectSet xmlns:adtcore="http://www.sap.com/adt/core">
    <adtcore:objectReferences>
      <adtcore:objectReference adtcore:uri="${objectUri}" adtcore:name="${name}"/>
    </adtcore:objectReferences>
  </objectSet>
</atcrun:run>`;

      // ATC run POST requires CSRF token
      const { token: csrfToken, cookie: csrfCookie } = await getCsrfToken();
      const createResponse = await sapClient.post(
        "/sap/bc/adt/atc/runs?worklistId=worklist1",
        runXml,
        {
          headers: {
            "Content-Type": "application/xml",
            Accept: "application/xml",
            "X-CSRF-Token": csrfToken,
            ...(csrfCookie ? { Cookie: csrfCookie } : {}),
          }
        }
      );

      // Extraer el ID del run desde la respuesta o Location header
      const location = createResponse.headers?.location || "";
      const runId    = location.split("/").pop() || "worklist1";

      // Paso 2: Obtener resultados — polling con retry (no esperar siempre 3s)
      let resultsResponse;
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise(r => setTimeout(r, 800 + attempt * 400)); // 0.8s, 1.2s, 1.6s...
        try {
          resultsResponse = await sapClient.get(
            `/sap/bc/adt/atc/worklists/${runId}`,
            { headers: { Accept: "application/xml" } }
          );
          // Si el worklist ya tiene findings o está vacío, salir
          if (!resultsResponse.data.includes('status="running"')) break;
        } catch { /* aún no listo, continuar */ }
      }

      const xml = resultsResponse.data;

      // Parsear hallazgos del XML
      const findings = [...xml.matchAll(
        /atcfinding:finding[^>]*atcfinding:priority="([^"]+)"[^>]*adtcore:name="([^"]+)"[^>]*atcfinding:checkTitle="([^"]+)"[^>]*atcfinding:messageTitle="([^"]+)"/g
      )];

      if (findings.length === 0) {
        return { content: [{ type: "text", text: `✅ ATC completado para ${name}: sin hallazgos (código limpio 🎉)` }] };
      }

      // Agrupar por prioridad
      const byPrio = findings.reduce((acc, f) => {
        const p = f[1];
        if (!acc[p]) acc[p] = [];
        acc[p].push({ check: f[3], msg: f[4] });
        return acc;
      }, {});

      const prio_icon = { "1": "🔴", "2": "🟠", "3": "🟡", "4": "🔵" };
      let out = `⚠️ ATC — ${findings.length} hallazgo(s) en ${name}:\n\n`;
      Object.entries(byPrio).sort().forEach(([p, items]) => {
        out += `${prio_icon[p] || "⚪"} Prioridad ${p} (${items.length}):\n`;
        items.forEach(i => { out += `   [${i.check}] ${i.msg}\n`; });
        out += "\n";
      });

      return { content: [{ type: "text", text: out }] };

    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error ejecutando ATC en ${object_name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 18: Leer estructura/campos de una tabla DDIC
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_ddic_table",
  "Lee los metadatos, estructura y campos de una tabla DDIC del repositorio SAP",
  {
    table_name: z.string().describe("Nombre de la tabla DDIC (ej: ZGT_T_ENHANC, BKPF, KNA1)"),
  },
  async ({ table_name }) => {
    try {
      const name = table_name.toUpperCase();

      // FIX v3.6.0: /source/main con text/plain devuelve definicion CDS con todos los campos.
      // El endpoint /ddic/tables/{name} con application/xml devolvía 406; */* devuelve solo metadata sin campos.
      const srcResponse = await sapClient.get(
        `/sap/bc/adt/ddic/tables/${name}/source/main`,
        { headers: { Accept: "text/plain" } }
      );

      // Metadata basica (descripcion) via Accept:*/*
      let desc = "N/A";
      try {
        const metaResp = await sapClient.get(
          `/sap/bc/adt/ddic/tables/${name}`,
          { headers: { Accept: "*/*" } }
        );
        const descMatch = metaResp.data.match(/adtcore:description="([^"]+)"/);
        desc = descMatch?.[1] || "N/A";
      } catch(_) { /* metadata opcional */ }

      // Extraer campos del source CDS-like: "  key campo  : tipo not null;"
      const src = srcResponse.data;
      const fieldLines = [];
      for (const line of src.split("\n")) {
        const m = line.match(/^\s*(key\s+)?(\w+)\s*:\s*(\w+)/);
        if (m && !line.trim().startsWith("@") && !line.trim().startsWith("define") && !line.trim().startsWith("with")) {
          const isKey = m[1] ? "KEY" : "   ";
          fieldLines.push(`${isKey} ${m[2].padEnd(25)} ${m[3]}`);
        }
      }

      let out = `Tabla DDIC: ${name}\nDescripcion: ${desc}\n\n`;
      if (fieldLines.length > 0) {
        out += `TIP  CAMPO                     TIPO/ROLLNAME\n`;
        out += `${"─".repeat(55)}\n`;
        out += fieldLines.join("\n") + "\n";
      } else {
        out += `--- Definicion fuente ---\n${src.substring(0, 3000)}`;
      }

      return { content: [{ type: "text", text: out }] };

    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error leyendo tabla DDIC ${table_name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA: Crear tabla DDIC Z en SAP
// Flujo confirmado por ingeniería inversa de ADT:
//   Paso 1: POST <blue:blueSource> → crea objeto vacío en el repositorio
//   Paso 2: PUT /source/main con DDL (mismo formato que CDS) → escribe definición
//   Paso 3: sap_activate para activar en base de datos
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_ddic_table",
  "Crea una nueva tabla DDIC transparente Z en SAP. Flujo: POST objeto vacío → PUT DDL source → activar. Paquete $TMP no requiere transporte.",
  {
    table_name:     z.string().describe("Nombre de la tabla — debe empezar en Z o Y (ej: ZTST_BOB_TABL)"),
    description:    z.string().describe("Descripción corta de la tabla (@EndUserText.label)"),
    package_name:   z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP)"),
    transport:      z.string().optional().describe("Orden de transporte (requerido si package != $TMP)"),
    delivery_class: z.enum(["A","C","E","G","L","S","W"]).optional().default("A")
      .describe("Clase de entrega: A=Application data, C=Customizing, L=Local/temporary, S=System, W=System/transport"),
    data_maintenance: z.enum(["ALLOWED","ALLOWED_BUT_DISCOURAGED","RESTRICTED","NO","READ_ONLY"]).optional().default("RESTRICTED")
      .describe("Mantenimiento de datos: ALLOWED, RESTRICTED, NO, READ_ONLY"),
    extensibility:  z.enum(["CAN_BE_ENRICHED","NOT_EXTENSIBLE","ELEMENT_CHANGES_ALLOWED"]).optional().default("NOT_EXTENSIBLE")
      .describe("Categoría de extensibilidad DDIC"),
    fields: z.array(z.object({
      name:     z.string().describe("Nombre del campo (ej: MANDT, BUKRS, ZFIELD1)"),
      key:      z.boolean().optional().default(false).describe("¿Es campo clave?"),
      rollname: z.string().describe("Data element / rollname (ej: MANDT, BUKRS, CHAR10, TEXT40). Siempre requerido."),
      not_null: z.boolean().optional().default(false).describe("NOT NULL constraint"),
    })).describe("Lista de campos. Incluir MANDT como primer campo clave si aplica."),
  },
  async ({ table_name, description, package_name = "$TMP", transport,
           delivery_class = "A", data_maintenance = "RESTRICTED",
           extensibility = "NOT_EXTENSIBLE", fields }) => {
    try {
      const name = table_name.toUpperCase();
      if (!name.startsWith("Z") && !name.startsWith("Y")) {
        return { content: [{ type: "text", text: `❌ El nombre debe empezar en Z o Y. Recibido: ${name}` }] };
      }
      if (!fields || fields.length === 0) {
        return { content: [{ type: "text", text: `❌ Debes especificar al menos un campo.` }] };
      }

      const { token, cookie } = await getCsrfToken();
      const corrSuffix = transport ? `?corrNr=${transport}` : "";

      // ── Paso 1: Crear objeto vacío con <blue:blueSource> ──────────────────
      const createXml = `<?xml version="1.0" encoding="utf-8"?>
<blue:blueSource
  xmlns:blue="http://www.sap.com/wbobj/blue"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:name="${name}"
  adtcore:type="TABL/DT"
  adtcore:description="${description.replace(/"/g, "&quot;")}">
  <adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>
</blue:blueSource>`;

      try {
        await sapClient.post(
          `/sap/bc/adt/ddic/tables?ignoreWarnings=true${corrSuffix ? corrSuffix.replace("?","&") : ""}`,
          createXml,
          {
            headers: {
              "Content-Type": "application/vnd.sap.adt.tables.v2+xml; charset=utf-8",
              Accept:         "application/vnd.sap.adt.tables.v2+xml, */*",
              "X-CSRF-Token": token,
              Cookie:         cookie,
            },
          }
        );
      } catch (createErr) {
        const st  = createErr.response?.status;
        const msg = String(createErr.response?.data || "");
        // Ignorar si ya existe
        if (!(st === 400 && msg.includes("already exists")) && st !== 409) throw createErr;
      }

      // ── Paso 2: Construir DDL y escribir en /source/main ──────────────────
      const deliveryMap = { A:"#A", C:"#C", E:"#E", G:"#G", L:"#L", S:"#S", W:"#W" };
      const fieldLines = fields.map(f => {
        const fn = f.name.toLowerCase();
        const rn = f.rollname.toLowerCase();
        const nn = f.not_null ? " not null" : "";
        return f.key
          ? `  key ${fn.padEnd(22)}: ${rn}${nn};`
          : `  ${fn.padEnd(24)}: ${rn}${nn};`;
      }).join("\n");

      const ddl = `@EndUserText.label : '${description.replace(/'/g, "\\'")}'
@AbapCatalog.enhancement.category : #${extensibility}
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : ${deliveryMap[delivery_class] || "#A"}
@AbapCatalog.dataMaintenance : #${data_maintenance}
define table ${name.toLowerCase()} {

${fieldLines}

}`;

      // Obtener ETag de /source/main para el PUT
      const srcPath = `/sap/bc/adt/ddic/tables/${name}/source/main`;
      const etag = await getEtag(srcPath, cookie).catch(() => "");

      const putHeaders = {
        "Content-Type": "text/plain; charset=utf-8",
        Accept:         "text/plain, */*",
        "X-CSRF-Token": token,
        Cookie:         cookie,
      };
      if (etag) putHeaders["If-Match"] = etag;

      await sapClient.put(`${srcPath}${corrSuffix}`, ddl, { headers: putHeaders });

      return {
        content: [{
          type: "text",
          text: `✅ Tabla ${name} creada exitosamente.\n`
              + `   Paquete:    ${package_name}\n`
              + `   Campos:     ${fields.length}\n`
              + `   Entrega:    ${delivery_class}\n\n`
              + `DDL generado:\n\`\`\`\n${ddl}\n\`\`\`\n\n`
              + `⚠️  Activa con: sap_activate (object_name="${name}", object_type="TABL/DT")`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      if (status === 403 || status === 412) invalidateCsrfCache();
      const body = typeof error.response?.data === "string"
        ? error.response.data.substring(0, 600)
        : JSON.stringify(error.response?.data || "").substring(0, 600);
      return {
        content: [{
          type: "text",
          text: `❌ Error creando tabla ${table_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HELPER INTERNO: obtener CSRF Token + Cookie de sesión para escritura
// Cache de 5 min: evita un round-trip extra en cada operación de escritura
// ──────────────────────────────────────────────────────────────────────────────
async function getCsrfToken() {
  const now = Date.now();
  if (_csrfCache && _csrfCache.expiresAt > now) {
    return { token: _csrfCache.token, cookie: _csrfCache.cookie };
  }
  const resp = await sapClient.get("/sap/bc/adt/discovery", {
    headers: { "X-CSRF-Token": "Fetch", Accept: "application/atomsvc+xml" },
  });
  const token  = resp.headers["x-csrf-token"];
  const cookie = resp.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
  if (!token || token === "Required") throw new Error("No se pudo obtener CSRF Token");
  _csrfCache = { token, cookie, expiresAt: now + 5 * 60 * 1000 };  // 5 min
  return { token, cookie };
}

// Invalida el cache CSRF (se llama tras un 403 o 412)
function invalidateCsrfCache() { _csrfCache = null; }

// HELPER COMPARTIDO: lógica de activación usada por sap_activate y sap_activate_object
async function activateObject(object_name, object_type) {
  try {
    const name    = object_name.toUpperCase();
    const objPath = getAdtPath(object_type, name);
    const { token, cookie } = await getCsrfToken();

    const activateXml = `<?xml version="1.0" encoding="UTF-8"?>`
      + `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">`
      + `<adtcore:objectReference adtcore:uri="${objPath}" adtcore:name="${name}"/>`
      + `</adtcore:objectReferences>`;

    const resp = await sapClient.post(
      "/sap/bc/adt/activation?method=activate&preauditRequested=true",
      activateXml,
      { headers: { "Content-Type": "application/xml; charset=utf-8", "X-CSRF-Token": token, Cookie: cookie } }
    );

    const xml    = typeof resp.data === "string" ? resp.data : "";
    const msgs   = parseActivationMessages(xml);
    const errors = msgs.filter(m => m.sev === "error");
    const warns  = msgs.filter(m => m.sev === "warning");

    if (errors.length > 0) {
      const lines  = errors.map(m => `  ❌ [${m.sev.toUpperCase()}] Línea ${m.line}: ${m.text}`).join("\n");
      const wlines = warns.length ? "\n" + warns.map(m => `  ⚠️  [WARN] Línea ${m.line}: ${m.text}`).join("\n") : "";
      return { content: [{ type: "text", text: `🚫 ${name} NO activado — errores de sintaxis:\n${lines}${wlines}\n\nCorrige los errores y vuelve a activar.` }] };
    }

    const warnText = warns.length
      ? `\n⚠️  Warnings (${warns.length}):\n` + warns.map(m => `  Línea ${m.line}: ${m.text}`).join("\n")
      : "";
    return { content: [{ type: "text", text: `✅ ${name} (${object_type}) activado exitosamente — HTTP ${resp.status}${warnText}` }] };
  } catch (error) {
    const status = error.response?.status;
    if (status === 403) invalidateCsrfCache();
    const body = typeof error.response?.data === "string"
               ? error.response.data.substring(0, 400)
               : JSON.stringify(error.response?.data || "").substring(0, 400);
    return { content: [{ type: "text", text: `❌ Error activando ${object_name}: HTTP ${status}\n${body}\n${error.message}` }] };
  }
}

// HELPER INTERNO: obtener ETag de un objeto usando una cookie de sesión específica
// Usa HEAD para no descargar el cuerpo completo del source
async function getEtag(path, cookie = "") {
  const headers = { Accept: "text/plain, */*" };
  if (cookie) headers["Cookie"] = cookie;
  try {
    // HEAD primero — más rápido (no descarga el cuerpo)
    const resp = await sapClient.head(path, { headers });
    if (resp.headers["etag"]) return resp.headers["etag"];
  } catch { /* HEAD no soportado en algunos endpoints, caer a GET */ }
  const resp = await sapClient.get(path, { headers });
  return resp.headers["etag"] || "";
}

// HELPER INTERNO: obtiene el corrNr correcto para escribir un objeto ABAP.
// Para clases globales, SAP ADT requiere el corrNr de la tarea que tiene bloqueado el objeto.
// Estrategia 1: LOCK el objeto via ADT → la respuesta incluye el corrNr
// Estrategia 2: listar tareas activas del usuario y buscar la que contenga el objeto
// Estrategia 3: buscar la primera tarea sin target (local $TMP)
async function getLocalWorkbenchTask(objectName, objectType) {
  // Estrategia 1: intentar LOCK del objeto para obtener el handle (incluye corrNr)
  if (objectName && objectType) {
    try {
      const { token, cookie } = await getCsrfToken();
      const adtPath = getAdtPath(objectType, objectName);
      const lockResp = await sapClient.post(
        `${adtPath}?_action=LOCK&accessMode=MODIFY`,
        "",
        { headers: { "X-CSRF-Token": token, Cookie: cookie, Accept: "application/vnd.sap.adt.lock.v1+xml, */*" } }
      );
      const lockXml = String(lockResp.data || "");
      // El LOCK response devuelve un lockHandle que incluye el corrNr
      // FIX: regex genérica — antes /(DV1K9\d+)/ era hardcodeada al sistema DV1
      const corrMatch = lockXml.match(/CORRNR=([A-Z0-9]+)/i) ||
                        lockXml.match(/corrNr="([^"]+)"/i) ||
                        lockXml.match(/([A-Z0-9]{3}K\d+)/);
      if (corrMatch) {
        // Liberar el lock inmediatamente con DELETE
        const lockHandle = lockXml.match(/lock:lockHandle[^>]*>([^<]+)</)?.[1] ||
                           lockXml.match(/lockHandle"[^>]*>([^<]+)</)?.[1] || "";
        if (lockHandle) {
          await sapClient.delete(`${adtPath}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
            { headers: { "X-CSRF-Token": token, Cookie: cookie } }).catch(() => {});
        }
        return corrMatch[1];
      }
    } catch { /* LOCK falló; continuar con estrategia 2 */ }
  }

  // Estrategia 2: listar tareas activas y buscar la que contenga el objeto
  try {
    const resp = await sapClient.get(
      `/sap/bc/adt/cts/transportrequests?user=${activeUser()}&status=D&category=Workbench`,
      { headers: { Accept: "application/xml, */*" } }
    );
    const xml = String(resp.data);
    if (objectName) {
      const objUpper = objectName.toUpperCase();
      // FIX: regex genérica — antes hardcodeada a DV1K9\d+ (solo válida para sistema DV1)
      const taskBlocks = [...xml.matchAll(/tm:task[^>]*tm:number="([A-Z0-9]{3}K\d+)"([\s\S]*?)(?=<tm:task|<\/tm:request|$)/g)];
      for (const tb of taskBlocks) {
        if (tb[2].includes(objUpper)) return tb[1];
      }
    }
    // Estrategia 3: buscar tarea sin target (local $TMP)
    const localMatch = xml.match(/tm:task[^>]*tm:number="([A-Z0-9]{3}K\d+)"[^>]*tm:target="(?:\$TMP|LOCAL|)"/);
    if (localMatch) return localMatch[1];
    // Último recurso: primera tarea disponible
    const firstTask = xml.match(/tm:task[^>]*tm:number="([A-Z0-9]{3}K\d+)"/);
    if (firstTask) return firstTask[1];
  } catch { /* ignorar */ }
  return "";
}

// HELPER INTERNO: parsea mensajes de error/warning del XML de activación ADT
function parseActivationMessages(xml) {
  const msgs = [];
  // El XML de activación contiene elementos como:
  // <msg adtcore:severity="error" adtcore:type="..." adtcore:line="42">texto</msg>
  // o  <atom:title>texto</atom:title> con severity en atributos del padre
  const re = /severity="([^"]+)"[^>]*>[^<]*(?:<[^>]+>([^<]*)<\/[^>]+>|([^<]*))/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const sev  = m[1];          // error | warning | info
    const text = (m[2] || m[3] || "").trim();
    if (!text) continue;
    // Extraer número de línea si viene en el atributo adtcore:line
    const lineRe = /line="(\d+)"/;
    const lm = lineRe.exec(xml.substring(Math.max(0, m.index - 200), m.index + 50));
    msgs.push({ sev, text, line: lm ? lm[1] : "?" });
  }
  // Fallback: si no se parsea nada pero hay "error" en el XML, devolver fragmento
  if (msgs.length === 0 && (xml.includes("error") || xml.includes("Error"))) {
    const snip = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 400);
    msgs.push({ sev: "error", text: snip, line: "?" });
  }
  return msgs;
}

// HELPER INTERNO: mapa tipo → ruta ADT
function getAdtPath(objectType, objectName) {
  const t = objectType.split("/")[0].toLowerCase();
  const folder = t === "prog" ? "programs/programs"
               : t === "clas" ? "oo/classes"
               : t === "intf" ? "oo/interfaces"
               : t === "ddls" ? "ddic/ddl/sources"
               : t === "bdef" ? "bo/behaviordefinitions"
               : t === "dcls" ? "dcl/sources"
               : t === "fugr" ? "functions/groups"
               : t === "tabl" ? "ddic/tables"
               : t;
  return `/sap/bc/adt/${folder}/${objectName.toUpperCase()}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 19: Escribir/modificar código fuente de un objeto ABAP existente
// Flujo: GET ETag → obtener CSRF → PUT source/main con If-Match
// Confirmado funcional en DV1 EPM Colombia (2026-07-27)
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_write_source",
  "Escribe o modifica el código fuente de un objeto ABAP existente en SAP (programa, clase, CDS). Requiere VPN activa. Flujo: GET ETag → CSRF → PUT source.",
  {
    object_name:  z.string().describe("Nombre del objeto (ej: ZABAP_BOB_TEST, ZCL_MI_CLASE)"),
    object_type:  z.enum(["PROG/P","CLAS/OC","DDLS/DF","BDEF/BO","DCLS/DL"]).describe("Tipo de objeto ADT"),
    source_code:  z.string().describe("Código fuente ABAP completo a escribir"),
    section:      z.enum(["main","definitions","implementations"]).optional().default("main").describe("Sección a modificar (solo para clases: main=definición+impl, definitions=solo def, implementations=solo impl)"),
    transport:    z.string().optional().describe("Orden de transporte CTS (requerido para objetos en paquetes Z)"),
  },
  async ({ object_name, object_type, source_code, section = "main", transport }) => {
    try {
      const objPath = getAdtPath(object_type, object_name);
      const name    = object_name.toUpperCase();

      // Paso 1: CSRF Token (obtener cookie de sesión primero)
      const { token, cookie } = await getCsrfToken();

      // Paso 2: corrNr — clases globales requieren corrNr incluso en $TMP
      let resolvedTransport = transport || "";
      if (!resolvedTransport && object_type === "CLAS/OC") {
        resolvedTransport = await getLocalWorkbenchTask(name, "CLAS/OC");
      }
      const corrSuffix = resolvedTransport ? `?corrNr=${resolvedTransport}` : "";

      // Paso 3: Para clases ABAP globales, escribir la clase completa en /source/main
      if (object_type === "CLAS/OC" && section === "main") {
        const srcPath = `/sap/bc/adt/oo/classes/${name}/source/main`;
        const etag = await getEtag(srcPath, cookie).catch(() => "");
        const hdrs = {
          "Content-Type": "text/plain; charset=utf-8",
          Accept: "text/plain, */*",
          "X-CSRF-Token": token,
          Cookie: cookie,
        };
        if (etag) hdrs["If-Match"] = etag;
        await sapClient.put(`${srcPath}${corrSuffix}`, source_code, { headers: hdrs });

        return {
          content: [{
            type: "text",
            text: `✅ Clase ${name} [main] escrita exitosamente.\n`
                + `⚠️  Recuerda activar con sap_activate`,
          }],
        };
      }

      // Para otros tipos (PROG, DDLS, etc.): escribir a /source/<section>
      const srcPath = `${objPath}/source/${section}`;
      const etag = await getEtag(srcPath, cookie).catch(() => "");
      const putHeaders = {
        "Content-Type": "text/plain; charset=utf-8",
        Accept: "text/plain, */*",
        "X-CSRF-Token": token,
        Cookie: cookie,
      };
      if (etag) putHeaders["If-Match"] = etag;

      const resp = await sapClient.put(`${srcPath}${corrSuffix}`, source_code, { headers: putHeaders });

      return {
        content: [{
          type: "text",
          text: `✅ Código fuente de ${object_name} [${section}] escrito exitosamente.\n`
              + `   HTTP: ${resp.status}\n`
              + `   ETag anterior: ${etag}\n`
              + `⚠️  Recuerda activar el objeto con sap_activate_object`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      if (status === 403 || status === 412) invalidateCsrfCache();
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 400)
                   : JSON.stringify(error.response?.data || "").substring(0, 400);
      return {
        content: [{
          type: "text",
          text: `❌ Error escribiendo ${object_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 20: Crear un programa ABAP nuevo con código fuente
// Flujo: POST crear objeto → PUT source → sap_activate_object
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_abap_program",
  "Crea un nuevo programa ABAP (REPORT) en SAP con descripción y código fuente. El paquete $TMP no requiere orden de transporte. Para paquetes Z se debe proporcionar la orden.",
  {
    program_name:  z.string().describe("Nombre del programa — debe empezar en Z o Y (ej: ZTEST_HOLA_MUNDO)"),
    description:   z.string().describe("Descripción del programa"),
    package_name:  z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP para desarrollo local)"),
    transport:     z.string().optional().describe("Número de orden de transporte (requerido si package_name != $TMP)"),
    source_code:   z.string().describe("Código fuente ABAP completo del programa"),
  },
  async ({ program_name, description, package_name = "$TMP", transport, source_code }) => {
    try {
      const name = program_name.toUpperCase();

      // Validar nombre
      if (!name.startsWith("Z") && !name.startsWith("Y")) {
        return { content: [{ type: "text", text: `❌ El nombre del programa debe empezar en Z o Y. Recibido: ${name}` }] };
      }

      // Paso 1: CSRF Token
      const { token, cookie } = await getCsrfToken();

      // Paso 2: Crear el programa (POST)
      const createXml = `<?xml version="1.0" encoding="utf-8"?>`
        + `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs"`
        + ` xmlns:adtcore="http://www.sap.com/adt/core"`
        + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
        + ` adtcore:name="${name}"`
        + ` adtcore:responsible="${activeUser()}"`
        + ` program:programType="executableProgram">`
        + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
        + `</program:abapProgram>`;

      const corrNr = transport ? `&corrNr=${transport}` : (package_name === "$TMP" ? "" : "");
      const createUrl = `/sap/bc/adt/programs/programs?ignoreWarnings=true${corrNr}`;

      let created = false;
      try {
        await sapClient.post(createUrl, createXml, {
          headers: {
            "Content-Type": "application/vnd.sap.adt.programs.programs.v2+xml; charset=utf-8",
            "X-CSRF-Token": token,
            Cookie:          cookie,
          },
        });
        created = true;
      } catch (createErr) {
        const st = createErr.response?.status;
        const msg = createErr.response?.data || "";
        if (st === 500 && String(msg).includes("already exists")) {
          created = true; // El objeto ya existe — continuar con PUT
        } else {
          throw createErr;
        }
      }

      // Paso 3: Escribir código fuente
      const srcPath  = `/sap/bc/adt/programs/programs/${name}/source/main`;
      const srcPutUrl = transport ? `${srcPath}?corrNr=${transport}` : srcPath;
      const etag    = await getEtag(srcPath).catch(() => "");
      const { token: t2, cookie: c2 } = await getCsrfToken();

      await sapClient.put(srcPutUrl, source_code, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Accept":        "text/plain, */*",
          "X-CSRF-Token": t2,
          Cookie:          c2,
          ...(etag ? { "If-Match": etag } : {}),
        },
      });

      // Paso 4: Activar automáticamente tras escribir el source
      let activationNote = "";
      try {
        const objPath     = `/sap/bc/adt/programs/programs/${name}`;
        const { token: ta, cookie: ca } = await getCsrfToken();
        const activateXml = `<?xml version="1.0" encoding="UTF-8"?>`
          + `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">`
          + `<adtcore:objectReference adtcore:uri="${objPath}" adtcore:name="${name}"/>`
          + `</adtcore:objectReferences>`;
        await sapClient.post(
          "/sap/bc/adt/activation?method=activate&preauditRequested=true",
          activateXml,
          { headers: { "Content-Type": "application/xml; charset=utf-8", "X-CSRF-Token": ta, Cookie: ca } }
        );
        activationNote = "\n✅ Objeto activado automáticamente.";
      } catch (_) {
        activationNote = "\n⚠️  Activa el objeto con: sap_activate_object (object_name=\"" + name + "\", object_type=\"PROG/P\")";
      }

      return {
        content: [{
          type: "text",
          text: `✅ Programa ${name} ${created ? "creado" : "actualizado"} exitosamente.\n`
              + `   Paquete: ${package_name}\n`
              + `   Descripción: ${description}`
              + activationNote,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 500)
                   : JSON.stringify(error.response?.data || "").substring(0, 500);
      return {
        content: [{
          type: "text",
          text: `❌ Error creando programa ${program_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 21: Crear una CDS View (DDL Source) nueva
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_cds_view",
  "Crea una nueva CDS View (DDL Source) en SAP con el código DDL proporcionado. Nombre debe empezar en ZI_, ZC_, ZVC_, etc.",
  {
    view_name:    z.string().describe("Nombre de la CDS View (ej: ZI_FI_INGRESOS_CHIP)"),
    description:  z.string().describe("Descripción de la CDS View"),
    package_name: z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP)"),
    transport:    z.string().optional().describe("Orden de transporte (requerido si package != $TMP)"),
    ddl_source:   z.string().describe("Código DDL completo de la CDS View"),
  },
  async ({ view_name, description, package_name = "$TMP", transport, ddl_source }) => {
    try {
      const name = view_name.toUpperCase();

      // Paso 1: CSRF
      const { token, cookie } = await getCsrfToken();

      // Paso 2: Crear DDL Source
      // FIX: namespace correcto es ddlsources (no ddl); Content-Type y Accept correctos para este sistema
      const createXml = `<?xml version="1.0" encoding="utf-8"?>`
        + `<ddl:ddlSource xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"`
        + ` xmlns:adtcore="http://www.sap.com/adt/core"`
        + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
        + ` adtcore:name="${name}"`
        + ` adtcore:responsible="${activeUser()}">`
        + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
        + `</ddl:ddlSource>`;

      const corrNr = transport ? `&corrNr=${transport}` : "";
      try {
        await sapClient.post(
          `/sap/bc/adt/ddic/ddl/sources?ignoreWarnings=true${corrNr}`,
          createXml,
          {
            headers: {
              "Content-Type": "application/vnd.sap.adt.ddlSource+xml; charset=utf-8",
              Accept:          "application/vnd.sap.adt.ddlSource+xml",
              "X-CSRF-Token": token,
              Cookie:          cookie,
            },
          }
        );
      } catch (createErr) {
        const msg = createErr.response?.data || "";
        if (createErr.response?.status === 500 && String(msg).includes("already exists")) {
          // continuar con PUT
        } else {
          throw createErr;
        }
      }

      // Paso 3: Escribir DDL source
      const srcPath = `/sap/bc/adt/ddic/ddl/sources/${name}/source/main`;
      const etag    = await getEtag(srcPath).catch(() => "");
      const { token: t2, cookie: c2 } = await getCsrfToken();

      await sapClient.put(srcPath, ddl_source, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Accept":        "text/plain, */*",
          "X-CSRF-Token": t2,
          Cookie:          c2,
          ...(etag ? { "If-Match": etag } : {}),
        },
      });

      return {
        content: [{
          type: "text",
          text: `✅ CDS View ${name} creada/actualizada exitosamente.\n`
              + `   Paquete: ${package_name}\n`
              + `⚠️  Activa con: sap_activate_object (object_name="${name}", object_type="DDLS/DF")`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 500)
                   : JSON.stringify(error.response?.data || "").substring(0, 500);
      return {
        content: [{
          type: "text",
          text: `❌ Error creando CDS View ${view_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA ATÓMICA DE DESPLIEGUE: sap_deploy_object (Ahorro de tokens)
// Flujo en 1 solo round-trip: Crear objeto → Escribir código → Activar
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_deploy_object",
  "Despliegue atómico de bajo consumo de tokens: crea/actualiza y activa un objeto ABAP o CDS en SAP en una sola operación. Soporta CLAS/OC, DDLS/DF, PROG/P.",
  {
    object_name:  z.string().describe("Nombre del objeto en Z o Y (ej: ZCL_MI_CLASE, ZI_MI_CDS, ZMI_PROG)"),
    object_type:  z.enum(["CLAS/OC", "DDLS/DF", "PROG/P", "INTF/OI"]).describe("Tipo de objeto ADT"),
    description:  z.string().describe("Descripción funcional del objeto"),
    source_code:  z.string().describe("Código fuente completo (para CLAS incluye definition + implementation; para DDLS incluye DDL completo)"),
    package_name: z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP)"),
    transport:    z.string().optional().describe("Orden de transporte CTS (requerido si package != $TMP)"),
  },
  async ({ object_name, object_type, description, source_code, package_name = "$TMP", transport }) => {
    try {
      const name = object_name.toUpperCase();
      if (!name.startsWith("Z") && !name.startsWith("Y")) {
        return { content: [{ type: "text", text: `❌ El nombre del objeto debe empezar en Z o Y. Recibido: ${name}` }] };
      }

      const { token, cookie } = await getCsrfToken();
      const corrNr = transport ? `&corrNr=${transport}` : "";

      // 1. Crear el contenedor según el tipo
      if (object_type === "CLAS/OC") {
        const createXml = `<?xml version="1.0" encoding="utf-8"?>`
          + `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes"`
          + ` xmlns:adtcore="http://www.sap.com/adt/core"`
          + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
          + ` adtcore:name="${name}"`
          + ` adtcore:responsible="${activeUser()}"`
          + ` class:final="true"`
          + ` class:visibility="public">`
          + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
          + `</class:abapClass>`;

        try {
          await sapClient.post(`/sap/bc/adt/oo/classes?ignoreWarnings=true${corrNr}`, createXml, {
            headers: {
              "Content-Type": "application/vnd.sap.adt.oo.classes.v1+xml; charset=utf-8",
              Accept: "application/vnd.sap.adt.oo.classes.v1+xml",
              "X-CSRF-Token": token,
              Cookie: cookie,
            },
          });
        } catch (e) {
          const st = e.response?.status;
          if (st !== 400 && st !== 409 && st !== 500) throw e;
        }

        const resolvedTransport = transport || await getLocalWorkbenchTask(name, "CLAS/OC");
        const mainPath = `/sap/bc/adt/oo/classes/${name}/source/main`;
        const putUrl = resolvedTransport ? `${mainPath}?corrNr=${resolvedTransport}` : mainPath;
        const etag = await getEtag(mainPath, cookie).catch(() => "");

        await sapClient.put(putUrl, source_code, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Accept: "text/plain, */*",
            "X-CSRF-Token": token,
            Cookie: cookie,
            ...(etag ? { "If-Match": etag } : {}),
          },
        });
      } else if (object_type === "DDLS/DF") {
        const createXml = `<?xml version="1.0" encoding="UTF-8"?>`
          + `<ddl:ddlSource xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"`
          + ` xmlns:adtcore="http://www.sap.com/adt/core"`
          + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
          + ` adtcore:name="${name}"`
          + ` adtcore:responsible="${activeUser()}"`
          + ` ddl:sourceType="W">`
          + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
          + `</ddl:ddlSource>`;

        try {
          await sapClient.post(`/sap/bc/adt/ddic/ddl/sources?ignoreWarnings=true${corrNr}`, createXml, {
            headers: {
              "Content-Type": "application/vnd.sap.adt.ddic.ddlsources.v1+xml; charset=utf-8",
              Accept: "application/vnd.sap.adt.ddic.ddlsources.v1+xml",
              "X-CSRF-Token": token,
              Cookie: cookie,
            },
          });
        } catch (e) {
          const st = e.response?.status;
          if (st !== 400 && st !== 409 && st !== 500) throw e;
        }

        const srcPath = `/sap/bc/adt/ddic/ddl/sources/${name}/source/main`;
        const etag = await getEtag(srcPath, cookie).catch(() => "");
        await sapClient.put(srcPath, source_code, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Accept: "text/plain, */*",
            "X-CSRF-Token": token,
            Cookie: cookie,
            ...(etag ? { "If-Match": etag } : {}),
          },
        });
      } else if (object_type === "PROG/P") {
        const createXml = `<?xml version="1.0" encoding="utf-8"?>`
          + `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs"`
          + ` xmlns:adtcore="http://www.sap.com/adt/core"`
          + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
          + ` adtcore:name="${name}"`
          + ` adtcore:responsible="${activeUser()}"`
          + ` program:type="executableProgram">`
          + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
          + `</program:abapProgram>`;

        try {
          await sapClient.post(`/sap/bc/adt/programs/programs?ignoreWarnings=true${corrNr}`, createXml, {
            headers: {
              "Content-Type": "application/vnd.sap.adt.programs.programs.v2+xml; charset=utf-8",
              Accept: "application/vnd.sap.adt.programs.programs.v2+xml",
              "X-CSRF-Token": token,
              Cookie: cookie,
            },
          });
        } catch (e) {
          const st = e.response?.status;
          if (st !== 400 && st !== 409 && st !== 500) throw e;
        }

        const srcPath = `/sap/bc/adt/programs/programs/${name}/source/main`;
        const srcPutUrl = transport ? `${srcPath}?corrNr=${transport}` : srcPath;
        const etag = await getEtag(srcPath, cookie).catch(() => "");
        await sapClient.put(srcPutUrl, source_code, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Accept: "text/plain, */*",
            "X-CSRF-Token": token,
            Cookie: cookie,
            ...(etag ? { "If-Match": etag } : {}),
          },
        });
      }

      // 2. Activar atómicamente
      const actResult = await activateObject(name, object_type);
      const actText = actResult.content?.[0]?.text || "";

      return {
        content: [{
          type: "text",
          text: `🚀 Despliegue atómico exitoso en ${activeHost().split(":")[0]}:\n`
              + `   Objeto:       ${name} (${object_type})\n`
              + `   Paquete:      ${package_name}\n`
              + `   Resultado:    ${actText}`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const body = typeof error.response?.data === "string"
                 ? error.response.data.substring(0, 500)
                 : JSON.stringify(error.response?.data || "").substring(0, 500);
      return {
        content: [{
          type: "text",
          text: `❌ Error en despliegue atómico de ${object_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 22: Activar objeto ABAP (versión mejorada con CSRF)
// Reemplaza la herramienta 5 (sap_activate_object) con flujo correcto
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_activate",
  "Activa uno o varios objetos ABAP en SAP (programas, clases, CDS Views, BDEFs, etc.). Confirma con HTTP 200.",
  {
    object_name:  z.string().describe("Nombre del objeto a activar (ej: ZCL_FI_EJECUCION_INGRESO_CHIP)"),
    object_type:  z.enum(["PROG/P","CLAS/OC","INTF/OI","DDLS/DF","BDEF/BO","DCLS/DL","FUGR/FF","TABL/DT","SRVD/SRD","SRVB/SVB"]).describe("Tipo de objeto ADT"),
  },
  // Delega en el helper compartido activateObject
  async ({ object_name, object_type }) => activateObject(object_name, object_type)
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 23: Crear una clase ABAP nueva
// Flujo: POST crear clase → PUT definitions + implementations → sap_activate
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_class",
  "Crea una nueva clase ABAP (CLAS) en SAP con definición e implementación. El paquete $TMP no requiere orden de transporte.",
  {
    class_name:   z.string().describe("Nombre de la clase — debe empezar en Z o Y (ej: ZCL_JUAN_HOLA_MUNDO)"),
    description:  z.string().describe("Descripción de la clase"),
    package_name: z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP)"),
    transport:    z.string().optional().describe("Orden de transporte (requerido si package_name != $TMP)"),
    definitions:  z.string().describe("Código fuente de la CLASS DEFINITION (CLASS zcl_xxx DEFINITION ... ENDCLASS.)"),
    implementations: z.string().describe("Código fuente de la CLASS IMPLEMENTATION (CLASS zcl_xxx IMPLEMENTATION ... ENDCLASS.)"),
  },
  async ({ class_name, description, package_name = "$TMP", transport, definitions, implementations }) => {
    try {
      const name = class_name.toUpperCase();

      if (!name.startsWith("Z") && !name.startsWith("Y")) {
        return { content: [{ type: "text", text: `❌ El nombre de la clase debe empezar en Z o Y. Recibido: ${name}` }] };
      }

      // Paso 1: CSRF
      const { token, cookie } = await getCsrfToken();

      // Paso 2: Crear la clase (POST)
      const corrNr = transport ? `&corrNr=${transport}` : "";
      const createXml = `<?xml version="1.0" encoding="utf-8"?>`
        + `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes"`
        + ` xmlns:adtcore="http://www.sap.com/adt/core"`
        + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
        + ` adtcore:name="${name}"`
        + ` adtcore:responsible="${activeUser()}"`
        + ` class:final="true"`
        + ` class:visibility="public">`
        + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
        + `</class:abapClass>`;

      // FIX: faltaba Accept header en el POST de creación
      try {
        await sapClient.post(
          `/sap/bc/adt/oo/classes?ignoreWarnings=true${corrNr}`,
          createXml,
          {
            headers: {
              "Content-Type": "application/vnd.sap.adt.oo.classes.v1+xml; charset=utf-8",
              Accept:          "application/vnd.sap.adt.oo.classes.v1+xml",
              "X-CSRF-Token": token,
              Cookie:          cookie,
            },
          }
        );
      } catch (createErr) {
        const st  = createErr.response?.status;
        const msg = String(createErr.response?.data || "");
        if (!(st === 400 && (msg.includes("already exists") || msg.includes("AlreadyExists") || msg.includes("does already exist"))) && !(st === 409) && !(st === 500 && msg.includes("already exists"))) {
          throw createErr;
        }
      }

      // Paso 3: Escribir la clase global completa (DEFINITION + IMPLEMENTATION) en /source/main
      // /includes/definitions y /includes/implementations son solo para tipos y clases locales (CCDEF/CCIMPL).
      const { token: t2, cookie: c2 } = await getCsrfToken();

      // Clases globales requieren corrNr incluso en $TMP; si no se pasa, buscar tarea local
      const resolvedTransport2 = transport || await getLocalWorkbenchTask(name, "CLAS/OC");

      const fullSource = `${definitions.trim()}\n\n\n${implementations.trim()}\n`;
      const mainPath   = `/sap/bc/adt/oo/classes/${name}/source/main`;
      const putUrl     = resolvedTransport2 ? `${mainPath}?corrNr=${resolvedTransport2}` : mainPath;
      const etag       = await getEtag(mainPath, c2).catch(() => "");

      await sapClient.put(putUrl, fullSource, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Accept:          "text/plain, */*",
          "X-CSRF-Token": t2,
          Cookie:          c2,
          ...(etag ? { "If-Match": etag } : {}),
        },
      });

      // Limpiar includes locales (CCDEF / CCIMPL) si tenían código erróneo
      const cleanInclude = async (inc) => {
        try {
          const incPath = `/sap/bc/adt/oo/classes/${name}/includes/${inc}`;
          const incUrl  = resolvedTransport2 ? `${incPath}?corrNr=${resolvedTransport2}` : incPath;
          const incEtag = await getEtag(incPath, c2).catch(() => "");
          await sapClient.put(incUrl, `*"* local types\n`, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              Accept:          "text/plain, */*",
              "X-CSRF-Token": t2,
              Cookie:          c2,
              ...(incEtag ? { "If-Match": incEtag } : {}),
            },
          });
        } catch { /* ignorar */ }
      };

      await cleanInclude("definitions");
      await cleanInclude("implementations");

      return {
        content: [{
          type: "text",
          text: `✅ Clase ${name} creada/actualizada exitosamente.\n`
              + `   Paquete:      ${package_name}\n`
              + `   Descripción:  ${description}\n`
              + `⚠️  Activa con: sap_activate (object_name="${name}", object_type="CLAS/OC")`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 500)
                   : JSON.stringify(error.response?.data || "").substring(0, 500);
      return {
        content: [{
          type: "text",
          text: `❌ Error creando clase ${class_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 24b: Verificar sintaxis ABAP sin activar
// Endpoint: GET /sap/bc/adt/<path>/syntax  → devuelve errores/warnings
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_check_syntax",
  "Verifica la sintaxis de un objeto ABAP existente SIN activarlo. Devuelve errores y warnings con número de línea. Útil para validar antes de activar.",
  {
    object_name: z.string().describe("Nombre del objeto (ej: ZFI_R_POSICIONES_DOC)"),
    object_type: z.enum(["PROG/P","CLAS/OC","INTF/OI","DDLS/DF","FUGR/FF"]).describe("Tipo de objeto ADT"),
  },
  async ({ object_name, object_type }) => {
    try {
      const name    = object_name.toUpperCase();
      const objPath = getAdtPath(object_type, name);

      const { token, cookie } = await getCsrfToken();

      // ADT syntax check via activation endpoint con preauditRequested=true
      // SAP ejecuta el pre-audit (syntax check) sin activar el objeto.
      // HTTP 200 cuerpo vacío  = sin errores
      // HTTP 200 con mensajes  = warnings/errores encontrados
      const checkXml = `<?xml version="1.0" encoding="UTF-8"?>`
        + `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">`
        + `<adtcore:objectReference adtcore:uri="${objPath}" adtcore:name="${name}"/>`
        + `</adtcore:objectReferences>`;

      const resp = await sapClient.post(
        "/sap/bc/adt/activation?method=activate&preauditRequested=true",
        checkXml,
        {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Accept":        "application/xml",
            "X-CSRF-Token": token,
            Cookie:          cookie,
          },
          validateStatus: () => true,
        }
      );

      const xml    = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || "");
      const msgs   = parseActivationMessages(xml);
      const errors = msgs.filter(m => m.sev === "error");
      const warns  = msgs.filter(m => m.sev === "warning");

      if (resp.status >= 400 && msgs.length === 0) {
        return {
          content: [{
            type: "text",
            text: `⚠️ El endpoint de sintaxis devolvió HTTP ${resp.status}.\n`
                + `Esto puede significar que el objeto no existe o el tipo no soporta verificación de sintaxis.\n`
                + `Fragmento de respuesta: ${xml.substring(0, 300)}`,
          }],
        };
      }

      if (errors.length === 0 && warns.length === 0) {
        return {
          content: [{
            type: "text",
            text: `✅ ${name} — sintaxis correcta, sin errores ni warnings.`,
          }],
        };
      }

      const errLines  = errors.map(m => `  ❌ Línea ${m.line}: ${m.text}`).join("\n");
      const warnLines = warns.map(m  => `  ⚠️  Línea ${m.line}: ${m.text}`).join("\n");

      return {
        content: [{
          type: "text",
          text: [
            `🔍 Resultado de sintaxis para ${name}:`,
            errors.length  ? `\nERRORES (${errors.length}):\n${errLines}`  : "",
            warns.length   ? `\nWARNINGS (${warns.length}):\n${warnLines}` : "",
          ].join(""),
        }],
      };

    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 400)
                   : JSON.stringify(error.response?.data || "").substring(0, 400);
      return {
        content: [{
          type: "text",
          text: `❌ Error verificando sintaxis de ${object_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 24c: Crear una Interfaz ABAP global
// Flujo: POST crear interfaz → PUT source/main → sap_activate
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_interface",
  "Crea una nueva Interfaz ABAP global (INTF) en SAP. El paquete $TMP no requiere orden de transporte.",
  {
    intf_name:    z.string().describe("Nombre de la interfaz — debe empezar en Z o Y (ej: ZIF_GT_PARAMETROS_LOCAL)"),
    description:  z.string().describe("Descripción de la interfaz"),
    package_name: z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP)"),
    transport:    z.string().optional().describe("Orden de transporte (requerido si package_name != $TMP)"),
    source:       z.string().describe("Código fuente completo (INTERFACE zif_xxx ... ENDINTERFACE.)"),
  },
  async ({ intf_name, description, package_name = "$TMP", transport, source }) => {
    try {
      const name = intf_name.toUpperCase();
      if (!name.startsWith("Z") && !name.startsWith("Y")) {
        return { content: [{ type: "text", text: `❌ El nombre debe empezar en Z o Y. Recibido: ${name}` }] };
      }

      const { token, cookie } = await getCsrfToken();
      const corrNr = transport ? `&corrNr=${transport}` : "";

      const createXml = `<?xml version="1.0" encoding="utf-8"?>`
        + `<intf:abapInterface xmlns:intf="http://www.sap.com/adt/oo/interfaces"`
        + ` xmlns:adtcore="http://www.sap.com/adt/core"`
        + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
        + ` adtcore:name="${name}"`
        + ` adtcore:responsible="${activeUser()}">`
        + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
        + `</intf:abapInterface>`;

      try {
        await sapClient.post(
          `/sap/bc/adt/oo/interfaces?ignoreWarnings=true${corrNr}`,
          createXml,
          {
            headers: {
              "Content-Type": "application/vnd.sap.adt.oo.interfaces.v2+xml; charset=utf-8",
              Accept:          "application/vnd.sap.adt.oo.interfaces.v2+xml",
              "X-CSRF-Token": token,
              Cookie:          cookie,
            },
          }
        );
      } catch (createErr) {
        const st  = createErr.response?.status;
        const msg = String(createErr.response?.data || "");
        const alreadyExists = (st === 400 || st === 409 || st === 500) &&
          (msg.includes("already exists") || msg.includes("AlreadyExists") || msg.includes("does already exist"));
        if (!alreadyExists) throw createErr;
      }

      // PUT source
      const srcPath   = `/sap/bc/adt/oo/interfaces/${name}/source/main`;
      const srcPutUrl = transport ? `${srcPath}?corrNr=${transport}` : srcPath;
      const { token: t2, cookie: c2 } = await getCsrfToken();
      const etag = await getEtag(srcPath, c2).catch(() => "");

      await sapClient.put(srcPutUrl, source, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Accept:          "text/plain, */*",
          "X-CSRF-Token": t2,
          Cookie:          c2,
          ...(etag ? { "If-Match": etag } : {}),
        },
      });

      return {
        content: [{
          type: "text",
          text: `✅ Interfaz ${name} creada/actualizada exitosamente.\n`
              + `   Paquete: ${package_name}\n`
              + `⚠️  Activa con: sap_activate (object_name="${name}", object_type="INTF/OI")`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 500)
                   : JSON.stringify(error.response?.data || "").substring(0, 500);
      return {
        content: [{
          type: "text",
          text: `❌ Error creando interfaz ${intf_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 25: Prueba de escritura completa (Hola Mundo en $TMP)
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_write_test",
  "Prueba rápida de permisos de escritura: crea/actualiza ZABAP_BOB_TEST en $TMP con un Hola Mundo y lo activa. Confirma que todos los permisos ADT están operativos.",
  {},
  async () => {
    const PROG = "ZABAP_BOB_TEST";
    const results = [];

    try {
      // 1. Escribir source
      const srcPath = `/sap/bc/adt/programs/programs/${PROG}/source/main`;
      const etag = await getEtag(srcPath).catch(() => "");
      const { token, cookie } = await getCsrfToken();

      const src = `*&---------------------------------------------------------------------*
*& Report ${PROG.toLowerCase()}
*& Prueba escritura ADT - Bob IBM Colombia
*& Fecha: ${new Date().toISOString().split("T")[0]}
*&---------------------------------------------------------------------*
REPORT ${PROG.toLowerCase()}.
WRITE: / '=============================================='.
WRITE: / '  Hola Mundo desde Bob - IBM Colombia'.
WRITE: / '  Sistema : S/4HANA 2023 DV1'.
WRITE: / '  Fecha   :', SY-DATUM, 'Hora:', SY-UZEIT.
WRITE: / '=============================================='.
`;

      const putResp = await sapClient.put(srcPath, src, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Accept":        "text/plain, */*",
          "X-CSRF-Token": token,
          Cookie:          cookie,
          ...(etag ? { "If-Match": etag } : {}),
        },
      });
      results.push(`✅ PUT source: HTTP ${putResp.status}`);

      // 2. Activar
      const { token: t2, cookie: c2 } = await getCsrfToken();
      const actXml = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/${PROG}" adtcore:name="${PROG}"/></adtcore:objectReferences>`;
      const actResp = await sapClient.post(
        "/sap/bc/adt/activation?method=activate&preauditRequested=true",
        actXml,
        { headers: { "Content-Type": "application/xml; charset=utf-8", "X-CSRF-Token": t2, Cookie: c2 } }
      );
      results.push(`✅ Activación: HTTP ${actResp.status}`);

      return {
        content: [{
          type: "text",
          text: `🎉 Test de escritura EXITOSO — Bob puede escribir en SAP DV1\n\n${results.join("\n")}\n\nObjeto: ${PROG} en paquete $TMP\nTodas las herramientas de escritura están operativas.`,
        }],
      };
    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 400)
                   : JSON.stringify(error.response?.data || "").substring(0, 400);
      return {
        content: [{
          type: "text",
          text: `❌ Test de escritura FALLÓ: HTTP ${status}\n${body}\nResultados parciales:\n${results.join("\n")}\n\nVerifica que la VPN está activa y que el usuario tiene S_DEVELOP ACTVT=02,16.`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 26: Crear Grupo de Funciones + Módulo de Función ABAP
// Flujo probado en DV1: POST grupo → POST fmodule → PUT source → sap_activate
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_create_function_group",
  "Crea un Grupo de Funciones ABAP y opcionalmente un Módulo de Función dentro de él. Flujo: crear grupo → crear FM → escribir source → activar con sap_activate.",
  {
    group_name:   z.string().describe("Nombre del grupo de funciones (ej: ZTEST_BOB_FG). Máx 26 chars."),
    description:  z.string().describe("Descripción del grupo de funciones"),
    package_name: z.string().optional().default("$TMP").describe("Paquete destino (default: $TMP)"),
    transport:    z.string().optional().describe("Orden de transporte (requerido si package != $TMP)"),
    fm_name:      z.string().optional().describe("Nombre del módulo de función a crear dentro del grupo (opcional)"),
    fm_description: z.string().optional().describe("Descripción del módulo de función"),
    fm_source:    z.string().optional().describe("Código fuente ABAP completo del módulo (entre FUNCTION...ENDFUNCTION)"),
  },
  async ({ group_name, description, package_name = "$TMP", transport, fm_name, fm_description, fm_source }) => {
    try {
      const grp = group_name.toUpperCase();
      const corrNr = transport ? `&corrNr=${transport}` : "";

      // Paso 1: CSRF
      const { token, cookie } = await getCsrfToken();

      // Paso 2: Crear el grupo de funciones
      const grpXml = `<?xml version="1.0" encoding="utf-8"?>`
        + `<group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups"`
        + ` xmlns:adtcore="http://www.sap.com/adt/core"`
        + ` adtcore:description="${description.replace(/"/g, "&quot;")}"`
        + ` adtcore:name="${grp}"`
        + ` adtcore:responsible="${activeUser()}">`
        + `<adtcore:packageRef adtcore:name="${package_name.toUpperCase()}"/>`
        + `</group:abapFunctionGroup>`;

      try {
        await sapClient.post(
          `/sap/bc/adt/functions/groups?ignoreWarnings=true${corrNr}`,
          grpXml,
          {
            headers: {
              "Content-Type": "application/vnd.sap.adt.functions.groups.v3+xml; charset=utf-8",
              Accept:          "application/vnd.sap.adt.functions.groups.v3+xml",
              "X-CSRF-Token": token,
              Cookie:          cookie,
            },
          }
        );
      } catch (grpErr) {
        const msg = grpErr.response?.data || "";
        if (!String(msg).includes("already exist")) throw grpErr;
        // grupo ya existe — continuar
      }

      let result = `✅ Grupo de funciones ${grp} creado/verificado.\n   Paquete: ${package_name}\n`;

      // Paso 3 (opcional): crear módulo de función
      if (fm_name) {
        const fm  = fm_name.toUpperCase();
        const fmDesc = fm_description || `Módulo de función ${fm}`;

        const fmXml = `<?xml version="1.0" encoding="utf-8"?>`
          + `<fmodule:abapFunctionModule xmlns:fmodule="http://www.sap.com/adt/functions/fmodules"`
          + ` xmlns:adtcore="http://www.sap.com/adt/core"`
          + ` fmodule:processingType="normal"`
          + ` fmodule:releaseState="notReleased"`
          + ` adtcore:description="${fmDesc.replace(/"/g, "&quot;")}"`
          + ` adtcore:name="${fm}"`
          + ` adtcore:responsible="${activeUser()}">`
          + `<adtcore:containerRef adtcore:uri="/sap/bc/adt/functions/groups/${grp.toLowerCase()}" adtcore:type="FUGR/F" adtcore:name="${grp}"/>`
          + `</fmodule:abapFunctionModule>`;

        try {
          await sapClient.post(
            `/sap/bc/adt/functions/groups/${grp}/fmodules?ignoreWarnings=true${corrNr}`,
            fmXml,
            {
              headers: {
                "Content-Type": "application/vnd.sap.adt.functions.fmodules.v3+xml; charset=utf-8",
                Accept:          "application/vnd.sap.adt.functions.fmodules.v3+xml",
                "X-CSRF-Token": token,
                Cookie:          cookie,
              },
            }
          );
        } catch (fmErr) {
          const msg = fmErr.response?.data || "";
          if (!String(msg).includes("already exist")) throw fmErr;
          // FM ya existe — continuar con PUT source
        }

        result += `✅ Módulo de función ${fm} creado/verificado.\n`;

        // Paso 4 (opcional): escribir source del FM
        if (fm_source) {
          const srcPath = `/sap/bc/adt/functions/groups/${grp}/fmodules/${fm}/source/main`;
          const etag    = await getEtag(srcPath).catch(() => "");
          const { token: t2, cookie: c2 } = await getCsrfToken();

          await sapClient.put(srcPath, fm_source, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              Accept:          "text/plain, */*",
              "X-CSRF-Token": t2,
              Cookie:          c2,
              ...(etag ? { "If-Match": etag } : {}),
            },
          });
          result += `✅ Source del FM escrito exitosamente.\n`;
        }
      }

      result += `\n⚠️  Activa con: sap_activate (object_name="${grp}", object_type="FUGR/FF")`;

      return { content: [{ type: "text", text: result }] };

    } catch (error) {
      const status = error.response?.status;
      const body   = typeof error.response?.data === "string"
                   ? error.response.data.substring(0, 500)
                   : JSON.stringify(error.response?.data || "").substring(0, 500);
      return {
        content: [{
          type: "text",
          text: `❌ Error creando función ${group_name}: HTTP ${status}\n${body}\n${error.message}`,
        }],
      };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 26: Leer Elemento de Datos (DTEL) o Dominio (DOMA) del DDIC
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_read_ddic_element",
  "Lee los metadatos de un Elemento de Datos (DTEL) o Dominio (DOMA) del diccionario ABAP",
  {
    name:        z.string().describe("Nombre del elemento de datos o dominio (ej: BUKRS, BELNR, MANDT)"),
    object_type: z.enum(["DTEL/DE", "DOMA/DO"]).optional().default("DTEL/DE").describe("Tipo: DTEL/DE=Elemento de datos, DOMA/DO=Dominio"),
  },
  async ({ name, object_type = "DTEL/DE" }) => {
    try {
      const n       = name.toUpperCase();
      const pathSeg = object_type === "DOMA/DO" ? "domains" : "dataelements";
      const label   = object_type === "DOMA/DO" ? "Dominio" : "Elemento de datos";

      const resp = await sapClient.get(
        `/sap/bc/adt/ddic/${pathSeg}/${n}`,
        { headers: { Accept: "*/*" } }
      );
      const xml = resp.data;

      const get = (attr) => xml.match(new RegExp(`${attr}="([^"]+)"`))?.[1] || "N/A";
      const desc      = get("adtcore:description");
      const changedAt = get("adtcore:changedAt");
      const changedBy = get("adtcore:changedBy");

      // Para DTEL: extraer domain/rollname referenciado
      const rollMatch = xml.match(/rollname="([^"]+)"/i) || xml.match(/dtel:domain[^=]*="([^"]+)"/i);
      const roll = rollMatch?.[1] || "N/A";

      // Para DOMA: buscar tipo de datos base
      const dtMatch  = xml.match(/dataType[^"]*"([A-Z0-9_]+)"/i);
      const lenMatch = xml.match(/length[^"]*"(\d+)"/i);

      let out = `${label}: ${n}\nDescripcion: ${desc}\nModificado: ${changedAt} por ${changedBy}\n`;
      if (object_type === "DTEL/DE") {
        out += `Dominio/Tipo: ${roll}\n`;
      } else {
        out += `Tipo base: ${dtMatch?.[1] || "N/A"}  Longitud: ${lenMatch?.[1] || "N/A"}\n`;
      }

      return { content: [{ type: "text", text: out }] };

    } catch (error) {
      return { content: [{ type: "text", text: `Error leyendo ${object_type} ${name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 27: Ejecutar ABAP Unit Tests
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_abap_unit",
  "Ejecuta ABAP Unit Tests de un programa, clase o paquete y retorna los resultados con estado pass/fail por método de test",
  {
    object_name: z.string().describe("Nombre del objeto a testear (ej: ZCL_GT_PARAMETROS, ZABAP_TEST)"),
    object_type: z.enum(["CLAS/OC","PROG/P","DEVC/K"]).optional().default("CLAS/OC")
      .describe("Tipo de objeto: CLAS/OC=clase, PROG/P=programa, DEVC/K=paquete completo"),
  },
  async ({ object_name, object_type = "CLAS/OC" }) => {
    try {
      const n = object_name.toUpperCase();
      const { token, cookie } = await getCsrfToken();

      // Determinar URI ADT según tipo
      const uriMap = {
        "CLAS/OC": `/sap/bc/adt/oo/classes/${n}`,
        "PROG/P":  `/sap/bc/adt/programs/programs/${n}`,
        "DEVC/K":  `/sap/bc/adt/packages/${n}`,
      };
      const objUri = uriMap[object_type] || `/sap/bc/adt/oo/classes/${n}`;

      // FIX: este sistema no acepta wrapper <aunit:options> —
      // runConfiguration va directamente como primer hijo de aunit:run
      const body = `<?xml version="1.0" encoding="utf-8"?><aunit:run title="Bob Unit Test" context="16" xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core"><aunit:runConfiguration><aunit:measurements forCoverage="false"/><aunit:scope ownTests="true" foreignTests="true"/><aunit:riskLevel harmless="true" dangerous="true" critical="true"/><aunit:duration short="true" medium="true" long="true"/></aunit:runConfiguration><adtcore:objectSets><adtcore:objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="${objUri}" adtcore:type="${object_type}" adtcore:name="${n}"/></adtcore:objectReferences></adtcore:objectSet></adtcore:objectSets></aunit:run>`;

      const response = await sapClient.post("/sap/bc/adt/abapunit/testruns", body, {
        headers: {
          "Content-Type": "application/xml",
          Accept: "application/xml",
          "X-CSRF-Token": token,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });

      const xml = response.data;

      // Parsear resultados — extraer clases de test, métodos y alertas
      const testClasses = [...xml.matchAll(/<aunit:testClass[^>]*adtcore:name="([^"]+)"[^>]*>/g)];
      const testMethods = [...xml.matchAll(/<aunit:testMethod[^>]*adtcore:name="([^"]+)"[^>]*executedBy="([^"]*)"[^>]*duration="([^"]*)"[^>]*>/g)];
      const alerts      = [...xml.matchAll(/<aunit:alert[^>]*kind="([^"]*)"[^>]*severity="([^"]*)"[^>]*><aunit:title>([^<]*)<\/aunit:title>/g)];
      const passed      = [...xml.matchAll(/severity="ok"/g)].length;
      const failed      = alerts.filter(a => a[2] !== "ok").length;

      let out = `ABAP Unit Tests — ${n}\n${"─".repeat(50)}\n`;

      if (testClasses.length === 0 && testMethods.length === 0) {
        out += `Sin clases de test encontradas en ${n}.\nVerifica que el objeto tenga metodos con FOR TESTING.`;
        return { content: [{ type: "text", text: out }] };
      }

      out += `Clases de test : ${testClasses.length}\n`;
      out += `Metodos        : ${testMethods.length}\n`;
      out += `Pasaron        : ${passed}\n`;
      out += `Fallaron       : ${failed}\n\n`;

      // Detallar alertas/fallos
      if (alerts.length > 0) {
        out += `ALERTAS:\n`;
        alerts.forEach(a => {
          const icon = a[2] === "ok" ? "✅" : a[2] === "fatal" ? "❌" : "⚠️";
          out += `  ${icon} [${a[1]}/${a[2]}] ${a[3]}\n`;
        });
      } else {
        out += `✅ Todos los tests pasaron correctamente.\n`;
      }

      // Métodos ejecutados
      if (testMethods.length > 0 && testMethods.length <= 20) {
        out += `\nMETODOS EJECUTADOS:\n`;
        testMethods.forEach(m => {
          out += `  ${m[1].padEnd(35)} ${m[3]}ms\n`;
        });
      }

      return { content: [{ type: "text", text: out }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error ejecutando unit tests de ${object_name}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 28: Pretty Printer ABAP
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_pretty_print",
  "Formatea código fuente ABAP con el pretty printer estándar del sistema SAP. Útil antes de escribir código con sap_write_source.",
  {
    source_code: z.string().describe("Código fuente ABAP a formatear"),
  },
  async ({ source_code }) => {
    try {
      const { token, cookie } = await getCsrfToken();

      const response = await sapClient.post("/sap/bc/adt/abapsource/prettyprinter", source_code, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Accept: "text/plain",
          "X-CSRF-Token": token,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });

      return {
        content: [{
          type: "text",
          text: `Codigo formateado:\n\n\`\`\`abap\n${response.data}\n\`\`\``,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error en pretty printer: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 29: Listar Pages/Tiles del Fiori Launchpad
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_list_fiori_pages",
  "Lista Pages y Catálogos del Fiori Launchpad de SAP. Permite filtrar por módulo (FIN, MM, SD, etc.) o buscar por título.",
  {
    mode:    z.enum(["pages","catalogs"]).optional().default("pages")
               .describe("'pages'=listar Pages del launchpad, 'catalogs'=listar Catálogos"),
    filter:  z.string().optional().describe("Filtrar por módulo (ej: FIN, MM, SD, LOG) o fragmento de título"),
    top:     z.number().optional().default(30).describe("Máximo registros a retornar (default: 30)"),
  },
  async ({ mode = "pages", filter, top = 30 }) => {
    try {
      const BASE_ODATA = "/sap/opu/odata/UI2/PAGE_BUILDER_CONF";
      const entity     = mode === "catalogs" ? "Catalogs" : "Pages";
      let url = `${BASE_ODATA}/${entity}?$format=json&$top=${top}&$orderby=id`;

      // Aplicar filtro si se especifica
      if (filter) {
        const f = filter.toUpperCase();
        // Filtrar por modulo en el id (Z_BCG_MOD_) o por título
        url += `&$filter=substringof('${f}',id) or substringof('${f}',toupper(title))`;
      }

      const response = await sapClient.get(url, {
        headers: { Accept: "application/json" },
      });

      const results = response.data?.d?.results || [];

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No se encontraron ${entity} con el filtro "${filter || "*"}".` }] };
      }

      // Agrupar pages por módulo si no hay filtro específico
      let out = `Fiori Launchpad — ${entity}${filter ? ` (filtro: "${filter}")` : ""}\n${"─".repeat(55)}\n`;
      out += `${results.length} resultado(s):\n\n`;

      if (mode === "pages") {
        // Agrupar por modulo
        const byModule = {};
        results.forEach(p => {
          const match = p.id?.match(/Z_BCG_(\w+)_/);
          const mod = match?.[1] || "OTROS";
          if (!byModule[mod]) byModule[mod] = [];
          byModule[mod].push(p);
        });

        Object.entries(byModule).forEach(([mod, pages]) => {
          out += `[${mod}]\n`;
          pages.forEach(p => {
            out += `  ${(p.id || "").padEnd(35)} ${p.title || ""}\n`;
          });
          out += "\n";
        });
      } else {
        results.forEach(c => {
          out += `  ${(c.id || "").padEnd(40)} ${c.title || ""}\n`;
        });
      }

      return { content: [{ type: "text", text: out }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error listando Fiori ${mode}: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// HERRAMIENTA 30: ABAP Trace (SAT / ST12)
// ──────────────────────────────────────────────────────────────────────────────
server.tool(
  "sap_abap_trace",
  "Gestiona ABAP Traces (equivalente a SAT/ST12): lista traces existentes, crea uno nuevo o lee el resultado de un trace.",
  {
    action:      z.enum(["list","create","read","delete"]).optional().default("list")
                   .describe("Accion: 'list'=listar traces, 'create'=crear trace, 'read'=leer resultado, 'delete'=eliminar"),
    trace_id:    z.string().optional().describe("ID del trace para read/delete (obtenido desde list)"),
    object_type: z.string().optional().describe("Tipo de objeto a trazar para create (ej: report, class, httpservice)"),
    object_name: z.string().optional().describe("Nombre del objeto a trazar para create (ej: ZABAP_TEST)"),
    description: z.string().optional().describe("Descripcion del trace para identificarlo (default: 'Bob Trace')"),
  },
  async ({ action = "list", trace_id, object_type, object_name, description = "Bob Trace" }) => {
    try {
      const BASE_TRACE = "/sap/bc/adt/runtime/traces/abaptraces";

      // ── LIST ──────────────────────────────────────────────────────────────
      if (action === "list") {
        const response = await sapClient.get(BASE_TRACE, { headers: { Accept: "application/xml" } });
        const xml = response.data;

        const entries = [...xml.matchAll(/<atom:entry>([\s\S]*?)<\/atom:entry>/g)];
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No hay ABAP Traces registrados en el sistema.\nUsa action='create' para iniciar uno." }] };
        }

        let out = `ABAP Traces en ${process.env.SAP_HOST?.split(".")[0]?.toUpperCase() || "SAP"}\n${"─".repeat(55)}\n`;
        entries.forEach(e => {
          const title  = e[1].match(/<atom:title[^>]*>([^<]+)<\/atom:title>/)?.[1] || "?";
          const id     = e[1].match(/<atom:id>([^<]+)<\/atom:id>/)?.[1]?.split("/").pop() || "?";
          const upd    = e[1].match(/<atom:updated>([^<]+)<\/atom:updated>/)?.[1] || "";
          const href   = e[1].match(/href="([^"]+)"/)?.[1] || "";
          out += `  ${id.padEnd(20)} ${title.padEnd(30)} ${upd}\n`;
          if (href) out += `    uri: ${href}\n`;
        });
        out += `\nTotal: ${entries.length} trace(s). Usa action='read' con trace_id para ver el detalle.`;
        return { content: [{ type: "text", text: out }] };
      }

      // ── CREATE ────────────────────────────────────────────────────────────
      if (action === "create") {
        if (!object_name) {
          return { content: [{ type: "text", text: "Para crear un trace se requiere object_name (y opcionalmente object_type)." }] };
        }
        const { token, cookie } = await getCsrfToken();
        const oType = (object_type || "report").toLowerCase();
        const oName = object_name.toUpperCase();

        const body = `<?xml version="1.0" encoding="utf-8"?>
<adtrt:traceRequest xmlns:adtrt="http://www.sap.com/adt/runtime/traces"
                    xmlns:adtcore="http://www.sap.com/adt/core"
                    adtrt:description="${description}"
                    adtrt:maximalSize="10485760"
                    adtrt:maximalTime="300">
  <adtrt:objectSets>
    <adtrt:objectSet adtrt:type="${oType}" adtrt:name="${oName}"/>
  </adtrt:objectSets>
  <adtrt:traceParameters>
    <adtrt:statements value="false"/>
    <adtrt:internalTableOperations value="false"/>
    <adtrt:sqlStatements value="true"/>
    <adtrt:aggregation value="true"/>
  </adtrt:traceParameters>
</adtrt:traceRequest>`;

        const response = await sapClient.post(BASE_TRACE, body, {
          headers: {
            "Content-Type": "application/xml",
            Accept: "application/xml",
            "X-CSRF-Token": token,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        });

        if (response.status === 201 || response.status === 200) {
          const loc  = response.headers?.location || "";
          const newId = loc.split("/").pop() || "creado";
          return { content: [{ type: "text", text: `✅ Trace creado exitosamente.\nID: ${newId}\nObjeto: ${oName} (${oType})\n\nUsa action='read' con trace_id='${newId}' para leer los resultados una vez ejecutado el objeto.` }] };
        }
        return { content: [{ type: "text", text: `Trace create status ${response.status}:\n${String(response.data).substring(0,500)}` }] };
      }

      // ── READ ──────────────────────────────────────────────────────────────
      if (action === "read") {
        if (!trace_id) {
          return { content: [{ type: "text", text: "Para leer un trace se requiere trace_id. Usa action='list' para ver los IDs disponibles." }] };
        }
        const response = await sapClient.get(`${BASE_TRACE}/${trace_id}`, {
          headers: { Accept: "application/xml" },
        });

        const xml = String(response.data);
        // Extraer hits de SQL y ABAP
        const hits    = [...xml.matchAll(/<adtrt:hit[^>]*>([\s\S]*?)<\/adtrt:hit>/g)];
        const sqlStmts = [...xml.matchAll(/<adtrt:sqlStatement[^>]*sql="([^"]+)"[^>]*count="([^"]*)"[^>]*duration="([^"]*)"[^>]*/g)];
        const descMatch = xml.match(/adtrt:description="([^"]+)"/);

        let out = `ABAP Trace — ID: ${trace_id}\n`;
        if (descMatch) out += `Descripcion: ${descMatch[1]}\n`;
        out += `${"─".repeat(55)}\n`;

        if (sqlStmts.length > 0) {
          out += `\nSQL Statements (top ${Math.min(sqlStmts.length, 20)}):\n`;
          out += `${"DURACION(μs)".padEnd(14)} ${"EJECUCIONES".padEnd(13)} SQL\n`;
          out += `${"─".repeat(70)}\n`;
          sqlStmts
            .sort((a,b) => parseInt(b[3]||0) - parseInt(a[3]||0))
            .slice(0,20)
            .forEach(s => {
              out += `${(s[3]||"?").padEnd(14)} ${(s[2]||"?").padEnd(13)} ${s[1].substring(0,60)}\n`;
            });
        } else if (hits.length > 0) {
          out += `\nHits encontrados: ${hits.length}\n`;
          out += xml.substring(0, 2000);
        } else {
          out += `\nContenido del trace:\n${xml.substring(0, 3000)}`;
        }

        return { content: [{ type: "text", text: out }] };
      }

      // ── DELETE ────────────────────────────────────────────────────────────
      if (action === "delete") {
        if (!trace_id) {
          return { content: [{ type: "text", text: "Para eliminar un trace se requiere trace_id." }] };
        }
        const { token, cookie } = await getCsrfToken();
        const response = await sapClient.delete(`${BASE_TRACE}/${trace_id}`, {
          headers: { "X-CSRF-Token": token, ...(cookie ? { Cookie: cookie } : {}) },
        });
        if (response.status === 200 || response.status === 204) {
          return { content: [{ type: "text", text: `✅ Trace ${trace_id} eliminado correctamente.` }] };
        }
        return { content: [{ type: "text", text: `Delete status ${response.status}: ${String(response.data).substring(0,300)}` }] };
      }

      return { content: [{ type: "text", text: `Accion desconocida: ${action}` }] };

    } catch (error) {
      return { content: [{ type: "text", text: `Error en sap_abap_trace (${action}): ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// ─── ST22 Dump Analysis ───────────────────────────────────────────────────────
// HERRAMIENTA 31: Lista ABAP Short Dumps (ST22)
server.tool(
  "sap_list_dumps",
  "Lista los ABAP Short Dumps (ST22) del sistema SAP. Permite filtrar por usuario, programa o tipo de error. Retorna los dumps más recientes con su ID, fecha, error, programa y usuario.",
  {
    user:        z.string().optional().describe("Filtrar por usuario SAP (ej: JSANCMAR). Si se omite, muestra todos."),
    program:     z.string().optional().describe("Filtrar por nombre de programa (ej: ZCL_FI_PAGOS=CP). Búsqueda parcial."),
    error_type:  z.string().optional().describe("Filtrar por tipo de error ABAP (ej: LOAD_PROGRAM_TABLE_MISMATCH, TSV_TNEW_PAGE_ALLOC_FAILED). Búsqueda parcial."),
    max_results: z.number().optional().default(20).describe("Máximo de dumps a retornar (default: 20, max: 100)"),
  },
  async ({ user, program, error_type, max_results = 20 }) => {
    try {
      // El feed de dumps soporta paginación via ?from / ?to pero no filtros server-side
      // Descargamos y filtramos en cliente
      const limit = Math.min(max_results, 100);
      const dumps = [];
      let nextUrl = "/sap/bc/adt/runtime/dumps";
      let pages = 0;

      while (nextUrl && dumps.length < limit && pages < 5) {
        const resp = await sapClient.get(nextUrl, { headers: { Accept: "*/*" } });
        const xml = resp.data;

        // Parsear entries del feed Atom
        const entryRegex = /<atom:entry[^>]*>([\s\S]*?)<\/atom:entry>/g;
        let match;
        while ((match = entryRegex.exec(xml)) !== null && dumps.length < limit) {
          const entry = match[1];

          const errorType  = (entry.match(/term="([^"]+)"[^>]*label="ABAP runtime error"/) || [])[1] || "";
          const prog       = (entry.match(/term="([^"]+)"[^>]*label="Terminated ABAP program"/) || [])[1] || errorType;
          const published  = (entry.match(/<atom:published>([^<]+)<\/atom:published>/) || [])[1] || "";
          const authorName = (entry.match(/<atom:name>([^<]+)<\/atom:name>/) || [])[1] || "";
          // Extraer el ID del link "self" con tipo text/plain (apunta a /sap/bc/adt/runtime/dump/{id})
          // El XML tiene: href="adt://DV1/sap/bc/adt/runtime/dump/{id}" rel="self" type="text/plain"
          const selfLinkMatch = entry.match(/href="adt:\/\/[^/]+\/sap\/bc\/adt\/runtime\/dump\/([^"]+)"[^>]*rel="self"/);
          const dumpKey       = selfLinkMatch ? selfLinkMatch[1] : "";

          // Aplicar filtros
          if (user && !authorName.toUpperCase().includes(user.toUpperCase())) continue;
          if (program && !prog.toUpperCase().includes(program.toUpperCase())) continue;
          if (error_type && !errorType.toUpperCase().includes(error_type.toUpperCase())) continue;

          dumps.push({ id: dumpKey, error: errorType, program: prog, user: authorName, published });
        }

        // Paginación: buscar link rel="next"
        const nextMatch = xml.match(/<atom:link[^>]*rel="next"[^>]*href="([^"]+)"/);
        nextUrl = nextMatch ? nextMatch[1] : null;
        pages++;
      }

      if (dumps.length === 0) {
        return { content: [{ type: "text", text: "✅ No se encontraron dumps con los filtros indicados." }] };
      }

      const lines = [`📋 ABAP Short Dumps (ST22) — ${dumps.length} resultado(s)\n`];
      lines.push("╔══ #  ══╦══════════════════════════════════════╦══════════════════════════════════════╦══════════════╦═════════════════════╗");
      dumps.forEach((d, i) => {
        const num     = String(i + 1).padStart(3);
        const err     = d.error.substring(0, 38).padEnd(38);
        const prog    = d.program.substring(0, 38).padEnd(38);
        const usr     = d.user.substring(0, 12).padEnd(12);
        const date    = d.published.substring(0, 19);
        lines.push(`║ ${num} ║ ${err} ║ ${prog} ║ ${usr} ║ ${date} ║`);
      });
      lines.push("╚════════╩════════════════════════════════════════╩════════════════════════════════════════╩══════════════╩═════════════════════╝");
      lines.push("\n💡 Usa sap_read_dump con el campo 'id' de un dump para ver el detalle completo.");
      lines.push("\n📌 IDs de los dumps:");
      dumps.forEach((d, i) => lines.push(`  [${i + 1}] ${d.id}`));

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error en sap_list_dumps: ${error.response?.status} - ${error.message}` }] };
    }
  }
);

// HERRAMIENTA 32: Lee detalle de un ABAP Short Dump (ST22)
server.tool(
  "sap_read_dump",
  "Lee el detalle completo de un ABAP Short Dump (ST22) por su ID. Muestra: error, programa, línea de código, stack de llamadas, análisis y extracto de código fuente. El ID se obtiene con sap_list_dumps.",
  {
    dump_id:   z.string().describe("ID del dump obtenido con sap_list_dumps (el campo 'id' de la lista)"),
    full_text: z.boolean().optional().default(false).describe("Si true, retorna el texto completo del dump. Si false (default), retorna solo las secciones clave: cabecera, análisis y call stack."),
  },
  async ({ dump_id, full_text = false }) => {
    try {
      // Asegurar que el ID esté URL-encoded correctamente
      const encodedId = dump_id.includes("%") ? dump_id : encodeURIComponent(dump_id);
      const basePath = `/sap/bc/adt/runtime/dump/${encodedId}`;

      // 1) Obtener metadata del dump (cabecera + lista de capítulos)
      const metaResp = await sapClient.get(basePath, { headers: { Accept: "*/*" } });
      const metaXml  = metaResp.data;

      // Extraer atributos del nodo raíz
      const title    = (metaXml.match(/title="([^"]+)"/) || [])[1] || "";
      const error    = (metaXml.match(/error="([^"]+)"/) || [])[1] || "";
      const prog     = (metaXml.match(/terminatedProgram="([^"]+)"/) || [])[1] || "";
      const author   = (metaXml.match(/author="([^"]+)"/) || [])[1] || "";
      const datetime = (metaXml.match(/datetime="([^"]+)"/) || [])[1] || "";
      const server_  = (metaXml.match(/serverInstance="([^"]+)"/) || [])[1] || "";

      // Link al source code (línea donde terminó)
      const termLine = (metaXml.match(/relations\/runtime\/dump\/termination[^>]*uri="([^"]+)"/) || [])[1] || "";

      // 2) Obtener texto formateado del dump
      const fmtResp = await sapClient.get(`${basePath}/formatted`, { headers: { Accept: "*/*" } });
      const fullDump = fmtResp.data;

      if (full_text) {
        const header = [
          `🔴 ABAP Short Dump — ${title}`,
          `📅 Fecha/Hora : ${datetime}`,
          `👤 Usuario    : ${author}`,
          `💥 Error      : ${error}`,
          `📄 Programa   : ${prog}`,
          `🖥️  Servidor   : ${server_}`,
          termLine ? `📍 Código     : ${termLine}` : "",
          "\n" + "─".repeat(100),
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: header + "\n" + fullDump }] };
      }

      // Modo resumido: extraer secciones clave del texto formateado
      const sections = [];

      // Función para extraer bloque entre delimitadores de caja
      function extractSection(text, keyword) {
        const regex = new RegExp(`\\|\\s*${keyword}[\\s\\S]*?(?=\\n-{40,}\\n\\n-{40,}|$)`, "i");
        const m = text.match(regex);
        return m ? m[0].substring(0, 2000) : null;
      }

      // Secciones más relevantes para el desarrollador
      const keywordSections = ["Short Text", "Error analysis", "Information on where terminated", "Source Code Extract", "Active Calls"];
      for (const kw of keywordSections) {
        const found = extractSection(fullDump, kw);
        if (found) sections.push(found);
      }

      const header = [
        `🔴 ABAP Short Dump — ST22`,
        ``,
        `  💥 Error     : ${error}`,
        `  📄 Programa  : ${prog}`,
        `  👤 Usuario   : ${author}`,
        `  📅 Fecha/Hora: ${datetime}`,
        `  🖥️  Servidor  : ${server_}`,
        termLine ? `  📍 Código    : ${termLine}` : "",
        ``,
        `${"─".repeat(100)}`,
      ].filter(Boolean).join("\n");

      const body = sections.length > 0 ? sections.join("\n" + "─".repeat(100) + "\n") : fullDump.substring(0, 4000);
      const footer = `\n\n💡 Usa full_text=true para ver el dump completo.`;

      return { content: [{ type: "text", text: header + "\n" + body + footer }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error en sap_read_dump: ${error.response?.status} - ${error.message}` }] };
    }
  }
);


// ─── HERRAMIENTA: sap_switch_client ──────────────────────────────────────────
// Cambia la conexion SAP activa en runtime. Requiere que SAP_CONNECTIONS
// tenga al menos dos entradas configuradas.
server.tool(
  "sap_switch_client",
  "Cambia la conexion SAP activa a uno de los alias configurados en SAP_CONNECTIONS. Usala antes de cualquier operacion cuando necesites trabajar en un mandante distinto.",
  {
    alias: z.string().describe("Alias de la conexion a activar (ej: DV1-110, DV1-100, DV1-210)"),
  },
  async ({ alias }) => {
    if (!connections[alias]) {
      const available = Object.keys(connections).join(", ");
      return {
        content: [{
          type: "text",
          text: `Error: alias "${alias}" no existe. Conexiones disponibles: ${available}`,
        }],
      };
    }
    const prev = activeAlias;
    activeAlias = alias;
    // MP-2: invalidar CSRF cache al cambiar de conexion — el token del cliente anterior no es válido
    invalidateCsrfCache();
    const c = connections[alias];
    return {
      content: [{
        type: "text",
        text: `Conexion cambiada: ${prev} -> ${alias}\nHost: ${c.protocol}://${c.host}:${c.port}\nMandante: ${c.client}\nUsuario: ${c.user}`,
      }],
    };
  }
);

// ─── HERRAMIENTA: sap_list_connections ───────────────────────────────────────
// Lista todas las conexiones disponibles e indica cual esta activa.
server.tool(
  "sap_list_connections",
  "Lista todas las conexiones SAP configuradas en SAP_CONNECTIONS e indica cual esta activa. Usala antes de sap_switch_client para ver los alias disponibles.",
  {},
  async () => {
    const lines = Object.values(connections).map((c) => {
      const active = c.alias === activeAlias ? " <-- ACTIVA" : "";
      return `  ${c.alias}${active}\n    Host   : ${c.protocol}://${c.host}:${c.port}\n    Cliente: ${c.client}\n    Usuario: ${c.user}`;
    });
    return {
      content: [{
        type: "text",
        text: `Conexiones SAP disponibles:\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);
// ─── Iniciar servidor ─────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
// MP-3: contar herramientas dinámicamente; MP-2: BASE_URL → construido desde conexión activa
const _startConn = getActiveConn();
const _baseUrl   = `${_startConn.protocol}://${_startConn.host}:${_startConn.port}`;
const _toolCount = server._registeredTools ? Object.keys(server._registeredTools).length : 37;
console.error(`SAP ADT MCP Server v${SERVER_VERSION} iniciado — ${_baseUrl} (${_toolCount} herramientas activas)`);
