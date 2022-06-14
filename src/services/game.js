import { Rx } from "@/rx.js";
import exclamationIcon from "../assets/ui/cartoon/icons/exclamation.png";

const pendingRequests = {};
const updateHandlers = {};
const websocketProtocol =
  window.location.protocol === "https:" ? "wss:" : "ws:";
const domain = `${window.location.hostname}${
  window.location.port ? ":" + window.location.port : ""
}`;

let connected = false;
let mapUpdateStream;

const startupIdStream = new Rx.ReplaySubject(1);
const resetStream = new Rx.ReplaySubject(1);
const dataUsageStream = new Rx.ReplaySubject(1);
const versionStream = new Rx.ReplaySubject(1);
dataUsageStream.next(0);
resetStream.next();
const craftDetailsStreams = {};

const fetcher = (url, params) =>
  new Promise((resolve, reject) =>
    fetch(url, params)
      .then(function (response) {
        if (response.ok) {
          response.text().then((body) => {
            let value;
            try {
              value = JSON.parse(body);
            } catch (e) {
              value = body;
            }
            resolve(value);
          });
        } else {
          response.text().then((error) => reject(error));
        }
        return response;
      })
      .catch((error) => {
        reject(error);
      })
  );

let openPromise;
let currentConnection;
let disconnectionDetectedStream = new Rx.ReplaySubject(1);
let disconnectionDetectedTimeout;

const secureAssets = {};
const entityStreams = {};
const entityStreamsObservable = {};
const infoStreams = {};
let rootEntityIdStream;
let requestId = 1;
let connectionCount = 0;
let itemCountStream;
let nameOverridesStream = new Rx.ReplaySubject(1);
nameOverridesStream.next({});
export const GameService = (window.GameService = {
  entityStreams,
  fetcher,

  getOpenPromise(reset = false, force = false) {
    if ((reset && connected) || force) {
      openPromise = null;
      connected = false;
      resetStream.next();
    }
    if (!openPromise) {
      if (currentConnection) {
        console.log("Closing connection", currentConnection.connectionId);
        currentConnection.close();
      }

      const connection = new WebSocket(
        `${websocketProtocol}//${domain}/api/ws`
      );
      connection.connectionId = ++connectionCount;
      console.log("Opening connection", connection.connectionId);
      window.currentConnection = currentConnection = connection;

      const setupDisconnectionDetection = () => {
        clearTimeout(disconnectionDetectedTimeout);
        connection.send("G");
        disconnectionDetectedStream.next(0);
        disconnectionDetectedTimeout = setTimeout(() => {
          disconnectionDetectedStream.next(1);
          disconnectionDetectedTimeout = setTimeout(() => {
            disconnectionDetectedStream.next(2);
          }, global.PING_FREQUENCY * 10);
        }, global.PING_FREQUENCY * 2.5);
      };

      connection.onmessage = (string) => {
        if (string.data === "P") {
          setupDisconnectionDetection();
          return;
        }

        let json = JSON.parse(string.data);

        if (json === "not_logged_in") {
          console.log("Websocket: Not logged in");
          window.location = "#/login";
          return;
        }

        if (json === "banned") {
          console.log("Websocket: Banned");
          window.location = "#/banned";
          return;
        }

        if (json.queuePosition) {
          console.log(`Websocket: in queue ${json.queuePosition}`);
          GameService.queuePosition = json.queuePosition;
          window.location = "#/queue";
          return;
        }

        dataUsageStream
          .first()
          .subscribe((soFar) =>
            dataUsageStream.next(soFar + string.data.length)
          );
        if (json.r5t) {
          if (pendingRequests[json.key]) {
            pendingRequests[json.key](json.data);
            delete pendingRequests[json.key];
          } else {
            throw new Error(
              "Received response to a request that wasn't sent: " +
                JSON.stringify(json)
            );
          }
        }
        if (json.u4e) {
          if (updateHandlers[json.u4e]) {
            updateHandlers[json.u4e](json.data);
          } else {
            console.warn(
              `Received update that does not have a handler: "${json.u4e}", data received:\n`,
              json.data
            );
          }
        }
      };

      openPromise = new Promise((resolve, reject) => {
        connection.onclose = (error, ...args) => {
          reject("Failed to connect");
          if (connection.connectionId === connectionCount) {
            setTimeout(() => {
              this.reconnect();
            }, 1000);
          }
        };

        GameService.registerHandler(
          REQUEST_CODES.RE_FETCH_OPEN_QUESTIONS,
          () => {
            GameService.getInfoStream("OpenQuestion", {}, true);
          }
        );

        GameService.registerHandler("ver", (version) => {
          versionStream.next(version);
        });
        return GameService.registerHandler("startup-id", (startupId) => {
          resolve();
          startupIdStream.next(startupId);
        });
      }).then(() => connection);

      GameService.registerHandler("javascript", (code) => {
        eval(`(${code})()`);
      });

      openPromise
        .then(() => {
          console.log("Connected", connection.connectionId);
          connected = true;
          setupDisconnectionDetection();
        })
        .catch(() => {});
    }
    return openPromise;
  },

  getDisconnectionDetectedStream() {
    return disconnectionDetectedStream.distinctUntilChanged();
  },

  getClientStartupId() {
    return process.env.VUE_APP_GIT_HASH;
  },

  getStartupIdStream() {
    return startupIdStream;
  },
  getVersionStream() {
    return versionStream;
  },
  getLastViewedVersionStream() {
    return GameService.getKnowledgeBaseStream().map((kb) => kb.lastVersion);
  },

  getKnowledgeBaseStream() {
    return GameService.getRootEntityStream()
      .pluck("knowledgeBase")
      .switchMap((knowledgeBaseId) =>
        knowledgeBaseId
          ? GameService.getEntityStream(
              knowledgeBaseId,
              ENTITY_VARIANTS.BASE,
              false,
              30 * MINUTES * IN_MILISECONDS
            )
          : Rx.Observable.empty()
      )
      .distinctUntilChanged(null, JSON.stringify);
  },

  getResearchesStream() {
    return GameService.getKnowledgeBaseStream()
      .pluck("researchesIds")
      .switchMap((researchIds) =>
        !researchIds.length
          ? Rx.Observable.of([])
          : Rx.combineLatest(
              researchIds.map((researchId) =>
                GameService.getInfoStream("Research", { researchId })
              )
            )
      );
  },
  fetchResearchUpdate(researchId) {
    GameService.getInfoStream("Research", { researchId }, true);
  },
  getCraftDetails(craftId) {
    if (!craftDetailsStreams[craftId]) {
      function fetchFromServer() {
        GameService.getInfoStream("Craft", { craftId })
          .first()
          .subscribe((data) => {
            LocalStorageService.setItem(key, data);
          });
      }

      const key = `craft.${craftId}`;
      const cached = LocalStorageService.getItem(key);
      if (!cached) {
        fetchFromServer();
      } else if (!cached.tools) {
        console.log(`Requires update from server ${craftId}`);
        LocalStorageService.removeItem(key);
        fetchFromServer();
      } else {
        const icons = [
          cached.icon,
          ...cached.materials.map((m) => m.itemDef.icon),
          ...cached.produce.map((m) => m.itemDef.icon),
        ];
        setTimeout(async () => {
          if (
            await icons.someAsync(
              async (icon) => !(await LocalStorageService.isImageCached(icon))
            )
          ) {
            console.log(`Refetching images for craft ${craftId}`);
            fetchFromServer();
          }
        });
      }
      craftDetailsStreams[craftId] = LocalStorageService.getItemStream(key);
    }
    return craftDetailsStreams[craftId];
  },
  getCraftsStream() {
    return GameService.getKnowledgeBaseStream()
      .pluck("craftIds")
      .switchMap((craftIds) =>
        !craftIds.length
          ? Rx.Observable.of([])
          : Rx.combineLatest(
              craftIds.map((craftId) => GameService.getCraftDetails(craftId))
            )
      );
  },
  getPlansStream() {
    return GameService.getKnowledgeBaseStream()
      .pluck("planIds")
      .switchMap((planIds) =>
        !planIds.length
          ? Rx.Observable.of([])
          : Rx.combineLatest(
              planIds.map((planId) =>
                GameService.getInfoStream("Plan", { planId })
              )
            )
      );
  },

  getRootEntityStream(forceReFetchId = false, forceReFetchData = false) {
    forceReFetchId = forceReFetchId || !rootEntityIdStream;
    if (!rootEntityIdStream) {
      rootEntityIdStream = new Rx.ReplaySubject(1);
    }
    if (forceReFetchId) {
      GameService.request(REQUEST_CODES.ROOT).then((rootEntityId) => {
        rootEntityIdStream.next(rootEntityId);
      });
    }
    if (forceReFetchData) {
      rootEntityIdStream.first().subscribe((rootEntityId) => {
        GameService.getEntityStream(rootEntityId, ENTITY_VARIANTS.SELF, true);
      });
    }
    return rootEntityIdStream
      .distinctUntilChanged()
      .switchMap((rootEntityId) => {
        if (rootEntityId) {
          return GameService.getEntityStream(
            rootEntityId,
            ENTITY_VARIANTS.SELF
          ).filter((entity) => {
            if (!entity) {
              ControlsService.goToCharacterCreator();
              return false;
            }
            return true;
          });
        }
        ControlsService.goToCharacterCreator();
        return Rx.Observable.empty();
      });
  },

  getLocationStream(forceFetch = false) {
    return GameService.getRootEntityStream()
      .map((entity) => entity?.location)
      .distinctUntilChanged()
      .switchMap((locationId) =>
        locationId
          ? GameService.getEntityStream(
              locationId,
              ENTITY_VARIANTS.DETAILS,
              forceFetch
            )
          : Rx.Observable.empty()
      );
  },

  getBackdropStyleStream() {
    return GameService.getLocationStream()
      .map((location) =>
        location?.backdrop
          ? {
              "background-image": `url(${location.backdrop})`,
            }
          : null
      )
      .filter((style) => !!style)
      .distinctUntilChanged(null, JSON.stringify);
  },

  getStructuresIdsStream() {
    const locationStream = GameService.getLocationStream();

    const locationStructures = locationStream.pluck("structures");
    const pathsStructures = locationStream
      .pluck("paths")
      .switchMap((ids) => GameService.getEntitiesStream(ids))
      .map((paths) =>
        paths.reduce((acc, p) => [...acc, ...(p.structures || [])], [])
      );

    return Rx.combineLatest(
      locationStructures,
      pathsStructures
    ).map(([locationStructures, pathsStructures]) => [
      ...(locationStructures || []),
      ...(pathsStructures || []),
    ]);
  },

  getLocationImgPath(location) {
    return "/api/locationGFX/" + location.id;
  },

  registerSecureAssets(assets) {
    Object.assign(secureAssets, assets || {});
  },
  getSecureResource(resourceFile) {
    const filename = resourceFile.replace(/.*[\/\\]/, "");
    return secureAssets[filename] || resourceFile;
  },

  getMyCreatureStream() {
    return GameService.getRootEntityStream().switchMap((entity) =>
      entity
        ? GameService.getEntityStream(entity.id, ENTITY_VARIANTS.DETAILS)
        : Rx.Observable.empty()
    );
  },

  getItemCountsByPublicIdStream() {
    if (!itemCountStream) {
      itemCountStream = GameService.getInventoryStream(
        GameService.getRootEntityStream()
      )
        .map((items) => {
          return items
            .filter((i) => !!i)
            .filter((i) => !i.isRuined)
            .reduce(
              (acc, item) => ({
                ...acc,
                [item.publicId]: (acc[item.publicId] || 0) + item.amount,
              }),
              {}
            );
        })
        .shareReplay(1);
    }
    return itemCountStream;
  },

  checkQuickActions() {
    this.getQuickActionsStream()
      .first()
      .subscribe((quickActions) => {
        quickActions
          .filter((action) => !!action.item)
          .forEach((action) => {
            GameService.getEntityStream(
              action.item.id,
              ENTITY_VARIANTS.BASE,
              true
            );
          });
      });
  },
  getQuickActionsStream() {
    let mainEntity = GameService.getRootEntityStream();
    const quickActionsStream = ControlsService.getSettingStream(
      "quickActions",
      []
    );
    const inventoryStream = GameService.getInventoryStream(mainEntity);
    return quickActionsStream
      .switchMap((quickActions) => {
        const itemIds = quickActions.map(({ itemId }) => itemId);
        return GameService.getEntitiesStream(itemIds).map((inventory) => {
          const inventoryMap = inventory.toObject(({ id }) => id);
          return quickActions.map(({ itemId, actionId, label }) => {
            const item = inventoryMap[itemId];
            return {
              item,
              actionId,
              label: label,
            };
          });
        });
      })
      .shareReplay(1);
  },

  getEquipmentMapStream() {
    return GameService.getRootEntityStream()
      .pluck("equipment")
      .map((equipment) =>
        Object.values(equipment || {}).toObject(
          (key) => key,
          () => true
        )
      );
  },

  getInventoryStream(inventoryEntity) {
    return inventoryEntity
      .map((entity) => entity?.inventory)
      .distinctUntilChanged(null, JSON.stringify)
      .switchMap((ids) => GameService.getEntitiesStream(ids))
      .map((items) => items.filter((item) => !!item));
  },

  getAllItemsByIdStream() {
    return Rx.combineLatest([
      GameService.getInventoryStream(GameService.getRootEntityStream()),
      GameService.getInventoryStream(GameService.getLocationStream()),
    ])
      .map(([bagsItems, locationItems]) => [
        ...(bagsItems || []),
        ...(locationItems || []),
      ])
      .map((items) => items.toObject((item) => item.id));
  },

  getEntityStream(
    id,
    variant = ENTITY_VARIANTS.BASE,
    forceFetch = false,
    retention = 30 * SECONDS * IN_MILISECONDS
  ) {
    if (typeof variant !== "string") {
      throw new Error(`Invalid variant provided: ${variant}`);
    }
    if (!id) {
      return Rx.Observable.empty();
    }
    const payloadId = buildPayloadId(id, variant);
    const initial = !entityStreams[payloadId];
    if (entityStreams[payloadId]) {
      clearTimeout(entityStreams[payloadId].deletionTimeout);
    }
    // console.log("REQUESTING", payloadId);
    if (initial) {
      // console.log("CREATE STREAM FOR", payloadId);
      entityStreams[payloadId] = new Rx.ReplaySubject(1);
      entityStreamsObservable[payloadId] = entityStreams[payloadId]
        .shareReplay(1)
        .finalize(() => {
          // console.log("FINAL UNSUB", payloadId);
          if (entityStreams[payloadId]) {
            entityStreams[payloadId].deletionTimeout = setTimeout(() => {
              if (!entityStreams[payloadId]?.observers.length) {
                // console.log("DELETE", payloadId);
                GameService.unloadEntity(payloadId);
              }
            }, retention);
          }
        })
        .publishReplay(1)
        .refCount();
      GameService.registerHandler(payloadId, ({ code, data }) => {
        if (entityStreams[payloadId]) {
          if (code === 200 && data) {
            entityStreams[payloadId].next({
              ...data,
              updatedOn: new Date(),
            });
          } else {
            GameService.unloadEntity(payloadId);
          }
        }
      });
    }
    if (initial || forceFetch) {
      // console.log("REQUEST DATA", payloadId, forceFetch);
      GameService.request(REQUEST_CODES.ENTITY_SUB, { payloadId }).then(
        (data) => {
          if (data) {
            entityStreams[payloadId]?.next({
              ...data,
              updatedOn: new Date(),
            });
          } else {
            entityStreams[payloadId]?.next(null);
            GameService.unloadEntity(payloadId);
          }
        }
      );
    }
    return entityStreamsObservable[payloadId];
  },

  unloadEntity(payloadId) {
    delete entityStreams[payloadId];
    delete entityStreamsObservable[payloadId];
    GameService.request(REQUEST_CODES.ENTITY_UNSUB, { payloadId });
  },

  getEntitiesStream(
    entitiesIds,
    variant = ENTITY_VARIANTS.BASE,
    forceFetch = false
  ) {
    if (!entitiesIds) {
      return Rx.Observable.empty();
    }
    if (!entitiesIds.length) {
      return Rx.Observable.of([]);
    }
    return Rx.combineLatest(
      entitiesIds.map((id) =>
        GameService.getEntityStream(id, variant, forceFetch)
      )
    ).map((entities) => entities.filter((e) => !!e));
  },

  getResetStream() {
    return resetStream;
  },

  requestPowersInfo() {
    return GameService.request(REQUEST_CODES.GET_POWERS_INFO).then(
      (response) => {
        if (!response || response.ok === false) {
          throw new Error(JSON.stringify(response));
        }
        return response;
      }
    );
  },

  request(name, params, key = undefined) {
    return GameService.getOpenPromise()
      .then((connection) => {
        return new Promise((resolve, reject) => {
          if (key === undefined) {
            key = `${new Date().getTime()}--${requestId++}`;
          }
          connection.send(
            JSON.stringify({
              r5t: name,
              params: params,
              key: key,
            })
          );
          pendingRequests[key] = resolve;
        });
      })
      .catch(() => {});
  },

  reconnect() {
    if (connected) {
      return GameService.getOpenPromise(true)
        .then((c) => {
          console.log("Re-fetching all entities");
          GameService.request(REQUEST_CODES.ROOT).then((rootEntityId) =>
            rootEntityIdStream.next(rootEntityId)
          );
          Object.keys(entityStreams).forEach((payloadId) => {
            const { id, variant } = destructurePayloadId(payloadId);
            GameService.getEntityStream(id, variant, true);
          });
        })
        .catch(() => {});
    }
  },

  performAction(target, action, parameters) {
    return GameService.request(REQUEST_CODES.ACTION, {
      targetId: target.id,
      actionId: action.actionId,
      parameters,
    }).then((response) => {
      if (response.errorResponse) {
        ToastNotify({
          icon: exclamationIcon,
          text: response.errorResponse,
        });
      } else if (!response.ok) {
        ToastNotify({
          icon: exclamationIcon,
          text: response.message,
        });
      }
      return response;
    });
  },

  getMapImageUpdateStream() {
    if (!mapUpdateStream) {
      mapUpdateStream = new Rx.Subject();
      GameService.registerHandler(REQUEST_CODES.MAP_UPDATE, () => {
        mapUpdateStream.next();
      });
    }
    return mapUpdateStream;
  },

  registerHandler(update, callback) {
    updateHandlers[update] = (data) => {
      callback(data);
    };
  },

  setNameOverride(code, name) {
    nameOverridesStream.first().subscribe((current) => {
      nameOverridesStream.next({
        ...current,
        [code]: name,
      });
    });
  },

  getNameOverrideStream() {
    return nameOverridesStream;
  },

  reportClientSideError(error) {
    this.request("client-side-error", {
      message: error?.message,
      stacktrace: error?.stack,
      userAgent: global.navigator?.userAgent,
    });
  },

  getInfoStream(infoType, params = {}, reFetch = false) {
    const key = `${infoType}:${JSON.stringify(params)}`;
    const alreadyExists = !!infoStreams[key];
    if (!alreadyExists) {
      infoStreams[key] = new Rx.ReplaySubject(1);
    }
    if (!alreadyExists || reFetch) {
      this.request(REQUEST_CODES.GET_INFO, {
        infoType,
        ...params,
      }).then((result) => {
        infoStreams[key].next(result);
      });
    }
    return infoStreams[key];
  },

  formatServerTime(timeMs) {
    const now = new Date();
    const then = new Date(timeMs);
    let result = "";
    if (now.getDate() !== then.getDate()) {
      result += `${then.toLocaleString("default", {
        weekday: "short",
      })}, ${then.getDate()} ${then.toLocaleString("default", {
        month: "short",
      })} `;
    }
    result += then.toLocaleString("default", {
      timeStyle: "short",
    });
    return result;
  },

  getCurrentObjectiveStream() {
    return GameService.getRootEntityStream().pluck("objective");
  },
});
