import { buildDomainSearches, normalizeAuthorizedDomain, OSIRIS_MAP_URL, parseDomainAnalysisCommand } from "./domainOsint";

test.each([
  ["example.com", "example.com"],
  ["  HTTPS://Sous-Domaine.Example.fr/  ", "sous-domaine.example.fr"],
  ["exemple.fr.", "exemple.fr"],
])("normalizes an authorized public domain: %s", (input, expected) => {
  expect(normalizeAuthorizedDomain(input)).toBe(expected);
});

test.each([
  "", "localhost", "serveur.local", "127.0.0.1", "192.168.1.5",
  "example.com/admin", "user@example.com", "https://example.com:8443", "ftp://example.com",
])("rejects a non-public-domain target: %s", (input) => {
  expect(normalizeAuthorizedDomain(input)).toBeNull();
});

test.each([
  ["Zirius, analyse ce domaine", ""],
  ["ΣIRIUS, analyse ce domaine exemple.fr", "exemple.fr"],
  ["analyse le domaine de sous.exemple.fr.", "sous.exemple.fr"],
])("recognizes the explicit domain command: %s", (command, domain) => {
  expect(parseDomainAnalysisCommand(command)).toEqual({ domain });
});

test("does not interpret other analysis requests as domain searches", () => {
  expect(parseDomainAnalysisCommand("analyse les séismes des dernières 24 heures")).toBeNull();
  expect(parseDomainAnalysisCommand("analyse ce dossier")).toBeNull();
});

test("builds only passive provider searches and keeps the HIBP domain on its owner dashboard", () => {
  const links = buildDomainSearches("example.com");
  expect(links.map((link) => link.id)).toEqual(["crtsh", "shodan", "censys", "hibp"]);
  expect(links.find((link) => link.id === "crtsh").url).toBe("https://crt.sh/?q=%25.example.com");
  expect(links.find((link) => link.id === "shodan").url).toBe(
    "https://www.shodan.io/search?query=hostname%3Aexample.com",
  );
  expect(links.find((link) => link.id === "hibp").url).toBe("https://haveibeenpwned.com/Dashboard#Domains");
  expect(OSIRIS_MAP_URL).toMatch(/^https:\/\/www\.osirisai\.live\/\?layers=/);
  expect(() => buildDomainSearches("127.0.0.1")).toThrow("adresse IP");
});
