"use strict";
const { randomUUID } = require("node:crypto");
const { api, ApiError } = require("./api");

function response(header, name, payload = {}, endpoint, properties) {
  const result = {
    event: {
      header: { namespace: "Alexa", name, payloadVersion: "3", messageId: randomUUID(),
        ...(header.correlationToken ? { correlationToken: header.correlationToken } : {}) },
      ...(endpoint ? { endpoint: { endpointId: endpoint } } : {}),
      payload,
    },
  };
  if (properties) result.context = { properties };
  return result;
}

function properties(data) {
  if (!data || !["ON", "OFF"].includes(data.state?.powerState) ||
      !Number.isFinite(Date.parse(data.observed_at))) throw new Error("État SIRIUS non conforme.");
  const result = [{
    namespace: "Alexa.PowerController", name: "powerState", value: data.state.powerState,
    timeOfSample: data.observed_at, uncertaintyInMilliseconds: 1000,
  }];
  if (data.state.brightness !== undefined) {
    if (!Number.isInteger(data.state.brightness) || data.state.brightness < 0 || data.state.brightness > 100) {
      throw new Error("Luminosité SIRIUS invalide.");
    }
    result.push({ namespace: "Alexa.BrightnessController", name: "brightness", value: data.state.brightness,
      timeOfSample: data.observed_at, uncertaintyInMilliseconds: 1000 });
  }
  return result;
}

function capability(name, property) {
  return { type: "AlexaInterface", interface: `Alexa.${name}`, version: "3",
    properties: { supported: [{ name: property }], proactivelyReported: false, retrievable: true } };
}

function makeHandler(call = api) {
  return async (event) => {
    const d = event?.directive;
    const header = d?.header || {};
    const endpoint = d?.endpoint?.endpointId;
    try {
      if (header.payloadVersion !== "3" || typeof header.messageId !== "string" ||
          !header.messageId || header.messageId.length > 128) throw new ApiError(422);
      const discovery = header.namespace === "Alexa.Discovery" && header.name === "Discover";
      const report = header.namespace === "Alexa" && header.name === "ReportState";
      const power = header.namespace === "Alexa.PowerController" && ["TurnOn", "TurnOff"].includes(header.name);
      const brightness = header.namespace === "Alexa.BrightnessController" && ["SetBrightness", "AdjustBrightness"].includes(header.name);
      if (!discovery && !report && !power && !brightness) {
        return response(header, "ErrorResponse", { type: "INVALID_DIRECTIVE", message: "Directive non prise en charge." }, endpoint);
      }
      const scope = discovery ? d.payload?.scope : d.endpoint?.scope;
      if (scope?.type !== "BearerToken" || typeof scope.token !== "string") throw new ApiError(401);
      if (discovery) {
        const data = await call("/api/integrations/tuya/alexa/discovery", scope.token);
        if (!Array.isArray(data.devices) || data.devices.length > 100) throw new Error("Découverte invalide.");
        const endpoints = data.devices.map((device) => {
          if (!/^[a-f0-9]{64}$/.test(device.endpoint_id) || typeof device.name !== "string" ||
              !device.name.trim() || !["LIGHT", "SMARTPLUG"].includes(device.category) ||
              typeof device.brightness !== "boolean") throw new Error("Appareil SIRIUS invalide.");
          return {
            endpointId: device.endpoint_id, manufacturerName: "SIRIUS / Tuya", friendlyName: device.name.slice(0, 60),
            description: "Appareil Smart Life autorisé dans SIRIUS", displayCategories: [device.category],
            capabilities: [{ type: "AlexaInterface", interface: "Alexa", version: "3" },
              capability("PowerController", "powerState"),
              ...(device.brightness ? [capability("BrightnessController", "brightness")] : [])],
          };
        });
        const result = response(header, "Discover.Response", { endpoints });
        result.event.header.namespace = "Alexa.Discovery";
        delete result.event.header.correlationToken;
        return result;
      }
      if (typeof endpoint !== "string" || !/^[a-f0-9]{64}$/.test(endpoint)) throw new ApiError(404);
      let data;
      if (report) data = await call(`/api/integrations/tuya/alexa/state/${endpoint}`, scope.token);
      else {
        let value;
        if (brightness) {
          value = d.payload?.[header.name === "SetBrightness" ? "brightness" : "brightnessDelta"];
          if (!Number.isInteger(value) || value < (header.name === "SetBrightness" ? 0 : -100) || value > 100) {
            throw new ApiError(422);
          }
        }
        data = await call("/api/integrations/tuya/alexa/command", scope.token, {
          endpoint_id: endpoint, message_id: header.messageId, action: header.name,
          ...(value === undefined ? {} : { value }),
        });
      }
      return response(header, report ? "StateReport" : "Response", {}, endpoint, properties(data));
    } catch (error) {
      console.error("SIRIUS Alexa Smart Home error", error instanceof ApiError ? error.status : error.name);
      const types = { 401: "EXPIRED_AUTHORIZATION_CREDENTIAL", 403: "INSUFFICIENT_PERMISSIONS",
        404: "NO_SUCH_ENDPOINT", 409: "ENDPOINT_BUSY", 422: "INVALID_VALUE", 503: "ENDPOINT_UNREACHABLE" };
      return response(header, "ErrorResponse", {
        type: types[error.status] || "INTERNAL_ERROR",
        message: "Commande non confirmée. Vérifiez SIRIUS et l'appareil ; aucune relance automatique.",
      }, endpoint);
    }
  };
}

exports.makeHandler = makeHandler;
exports.handler = makeHandler();
