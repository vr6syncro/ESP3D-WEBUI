/*
 WsContext.js - ESP3D WebUI context file

 Copyright (c) 2021 Alexandre Aussourd. All rights reserved.
 Modified by Luc LEBOSSE 2021
 
 This code is free software; you can redistribute it and/or
 modify it under the terms of the GNU Lesser General Public
 License as published by the Free Software Foundation; either
 version 2.1 of the License, or (at your option) any later version.
 This code is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 Lesser General Public License for more details.
 You should have received a copy of the GNU Lesser General Public
 License along with This code; if not, write to the Free Software
 Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
*/
import { h, createContext } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useReducer,
  useContext,
} from "preact/hooks";
import { Parser } from "../components/Targets";
import { limitArr } from "../components/Helpers";
import {
  useUiContext,
  useSettingsContext,
  useHttpQueueContext,
} from "../contexts";
import { T } from "../components/Translations";

/*
 * Local const
 *
 */
const WsContext = createContext("wsContext");
const useWsContext = () => useContext(WsContext);
const pingDelay = 5000;
const maxReconnections = 4;
const INITIAL_STATE = {
  temp: [],
  files: [],
};

const reducer = (state, action) => {
  if (!action) return INITIAL_STATE;
  switch (action.type) {
    case "temp":
      return {
        ...state,
        temp: limitArr([...state.temp, action.values], 400),
      };
    case "files":
      return {
        ...state,
        files: action.values,
      };
    default:
      return { ...INITIAL_STATE, ...state };
  }
};

function getCookie(cname) {
  let name = cname + "=";
  let decodedCookie = decodeURIComponent(document.cookie);
  let ca = decodedCookie.split(";");
  for (var i = 0; i < ca.length; i++) {
    var c = ca[i];
    while (c.charAt(0) == " ") {
      c = c.substring(1);
    }
    if (c.indexOf(name) == 0) {
      return c.substring(name.length, c.length);
    }
  }
  return "";
}

const WsContextProvider = ({ children }) => {
  const { toasts, connection } = useUiContext();
  const { removeAllRequests } = useHttpQueueContext();
  const [parsedValues, dispatch] = useReducer(reducer, INITIAL_STATE);
  const dataBuffer = useRef([]);
  const { settings } = useSettingsContext();
  const parser = useRef(new Parser());
  const wsConnection = useRef();
  const [isPingPaused, setIsPingPaused] = useState(false);
  const [isPingStarted, setIsPingStarted] = useState(false);
  const isLogOff = useRef(false);
  const reconnectCounter = useRef(0);
  const connectionState = useRef({
    connected: false,
    status: "not connected",
    reason: "connecting",
  });
  const [wsData, setWsData] = useState([]);

  const splitArrayBufferByLine = (arrayBuffer) => {
    const bytes = new Uint8Array(arrayBuffer);
    return bytes.reduce(
      (acc, curr) => {
        if (curr == 10 || curr == 13) return [...acc, []];
        const i = Number(acc.length - 1);
        return [...acc.slice(0, i), [...acc[i], curr]];
      },
      [[]]
    );
  };

  const ping = (start = false) => {
    if (isLogOff.current) return;
    if (!isPingStarted) {
      setIsPingStarted(true);
    } else {
      if (start) return;
    }
    setTimeout(ping, pingDelay);
    if (isPingPaused) return;
    if (wsConnection.current) {
      if (wsConnection.current.readyState == 1) {
        const c = getCookie("ESPSESSIONID");
        const pingmsg = "PING:" + (c.length > 0 ? c : "none");
        wsConnection.current.send(pingmsg);
      }
    }
  };

  const onMessageCB = (e) => {
    if (isLogOff.current) return;
    const { parse } = parser.current;
    //for binary messages used for terminal
    const stdOutData = e.data;
    if (stdOutData instanceof ArrayBuffer) {
      const newLines = splitArrayBufferByLine(stdOutData).map((line) => ({
        std: "out",
        value: line.reduce((acc, curr) => acc + String.fromCharCode(curr), ""),
      }));
      dataBuffer.current = [...dataBuffer.current, ...newLines];
      [...newLines].forEach((line) => {
        dispatch(parse(line.value));
      });
    } else {
      //others txt messages
      console.log(stdOutData);
      const eventLine = stdOutData.split(":");
      if (eventLine.length > 1) {
        switch (eventLine[0].toUpperCase()) {
          case "CURRENTID":
            settings.current.wsID = eventLine[1];
            break;
          case "ACTIVEID":
            if (eventLine[1] != settings.current.wsID) {
              Disconnect("already connected");
            }
            break;
          case "PING":
            if (eventLine.length == 3) {
              if (eventLine[1] <= 0) {
                Disconnect("sessiontimeout");
              } else if (eventLine[1] < 30000) {
                //TODO: Show dialog
                console.log("under 30 sec : ");
                toasts.addToast({
                  content: "Time out:" + Math.floor(eventLine[1] / 1000),
                  type: "warning",
                });
              }
            }
            break;
          default:
            //unknow event
            break;
        }
      }
      dataBuffer.current = [
        ...dataBuffer.current,
        { std: "out", value: stdOutData },
      ];
      const parsedRes = parse(stdOutData);
      if (parsedRes) {
        dispatch(parsedRes);
      }
    }
    setWsData(dataBuffer.current);
  };

  const Disconnect = (reason) => {
    //connectionState.current = {
    //  connected: true,
    //  status: "request disconnection",
    //  reason: reason,
    //};
    console.log("request disconnection");
    //setIsPingStarted(false);
    //setIsPingPaused(true);
    //isLogOff.current = true;
  };

  const onOpenCB = (e) => {
    console.log("open");
    connectionState.current = {
      connected: true,
      status: "connected",
      reason: "",
    };
    reconnectCounter.current = 0;
    ping(true);
  };

  const onCloseCB = (e) => {
    console.log("CloseWS");
    connectionState.current.connected = false;
    //seems sometimes it disconnect so wait 3s and reconnect
    //if it is not a log off
    if (!isLogOff.current) {
      console.log("Try close :" + reconnectCounter.current);
      if (!isPingPaused) reconnectCounter.current++;
      if (reconnectCounter.current >= maxReconnections) {
        Disconnect("connectionlost");
        // window.location.reload();
      } else {
        setTimeout(setupWS, 3000);
      }
    }
  };

  const onErrorCB = (e) => {
    reconnectCounter.current++;
    console.log(e);
    toasts.addToast({ content: "WS Error", type: "error" });
    connectionState.current = {
      connected: false,
      status: "error",
      reason: "error",
    };
  };
  const setupWS = () => {
    const path =
      settings.current.connection.WebCommunication === "Synchronous"
        ? ""
        : "/ws";
    wsConnection.current = new WebSocket(
      `ws://${settings.current.connection.WebSocketIP}:${settings.current.connection.WebSocketport}${path}`,
      ["arduino"]
    );
    wsConnection.current.binaryType = "arraybuffer";

    //Handle msg of ws
    wsConnection.current.onopen = (e) => onOpenCB(e);
    wsConnection.current.onmessage = (e) => onMessageCB(e);
    wsConnection.current.onclose = (e) => onCloseCB(e);
    wsConnection.current.onerror = (e) => onErrorCB(e);
  };

  useEffect(() => {
    if (connectionState.current.status === "request disconnection") {
      if (wsConnection.current) {
        connection.setConnectionState({
          connected: false,
          authenticate: connection.connectionState.authenticate,
          page: connectionState.current.reason,
        });
        wsConnection.current.close();
        //Abort  / Remove all queries
        removeAllRequests();
        //TODO: Stop polling
        connectionState.current = {
          connected: false,
          status: "closed",
          reason: connectionState.current.reason,
        };
      }
    }
  }, [connectionState.current]);

  useEffect(() => {
    if (settings.current.connection) {
      setupWS();
    }
  }, [settings.current.connection]);

  const addData = (cmdLine) => {
    const newWsData = [...wsData, cmdLine];
    dataBuffer.current = newWsData;
    setWsData(newWsData);
  };
  const setData = (cmdLine) => {
    dataBuffer.current = cmdLine;
    setWsData(cmdLine);
  };

  const store = {
    ws: wsConnection.current,
    state: connectionState,
    data: wsData,
    parsedValues,
    setData,
    addData,
    setIsPingPaused, //to be used in HTTP queries
    Disconnect,
  };

  return <WsContext.Provider value={store}>{children}</WsContext.Provider>;
};

export { WsContextProvider, useWsContext };
