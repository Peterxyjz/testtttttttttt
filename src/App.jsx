import React, { useEffect, useRef, useState } from "react";
import * as signalR from "@microsoft/signalr";

const HUB_URL = "https://localhost:7057/eventroomhub";

export default function App() {
  const [conn, setConn] = useState(null);
  const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        "turn:160.25.81.144:3478",
        "turn:160.25.81.144:3478?transport=tcp",
        "turn:160.25.81.144:5349?transport=tcp",
      ],
      username: "polygo",
      credential: "polygo2024",
    },
  ];
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState("demo-room");
  const [name, setName] = useState("react-user");
  const [myId, setMyId] = useState("-");
  const [participants, setParticipants] = useState({});
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const chatBoxRef = useRef(null);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);
  const [wavingUsers, setWavingUsers] = useState({});
  const [isWaving, setIsWaving] = useState(false);

  const localVideoRef = useRef(null);
  const pcsRef = useRef({});
  const localStreamRef = useRef(null);
  const outgoingCandidatesRef = useRef([]); // queue of { remoteId, candidateJson }
  const connRef = useRef(null);

  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [chatMessages]);


  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(HUB_URL)
      .withAutomaticReconnect()
      .build();

    connRef.current = connection;

    connection.on("MicStateChanged", (connId, enabled) => {
      setParticipants((prev) => {
        if (!prev[connId]) return prev;
        return { ...prev, [connId]: { ...prev[connId], micEnabled: enabled } };
      });
    });

    connection.on("CamStateChanged", (connId, enabled) => {
      setParticipants((prev) => {
        if (!prev[connId]) return prev;
        return { ...prev, [connId]: { ...prev[connId], camEnabled: enabled } };
      });
    });

    connection.on("ToggleMicCommand", async (enabled) => {
      await ensureLocalStream();
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = enabled;
        setMicEnabled(enabled);
      }
    });

    connection.on("ToggleCamCommand", async (enabled) => {
      await ensureLocalStream();
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = enabled;
        setCamEnabled(enabled);
      }
    });

    connection.on("KickedFromRoom", (roomName) => {
      alert("You have been kicked from the room by the host.");
      leaveRoom(); // reuse your existing leave function
    });
    

    connection.on("ReceiveChatMessage", (userName, message) => {
      setChatMessages(prev => [...prev, { userName, message }]);
    });


    connection.on("SetRole", (role, connId, hostId) => {
      setMyId(connId);
      setHostId(hostId);
      setIsHost(role === "host");
    });

    connection.on("ReceiveWave", (connId, userName) => {
      setWavingUsers(prev => ({ ...prev, [connId]: userName }));
    });

    connection.on("ReceiveUnwave", (connId) => {
      setWavingUsers(prev => {
        const copy = { ...prev };
        delete copy[connId];
        return copy;
      });
    });


    connection.on("UserJoined", (userName, role, connId) => {
      setParticipants((prev) => ({
        ...prev,
        [connId]: { name: userName, micEnabled: true, camEnabled: true },
      }));
    });

    connection.on("UserLeft", (connId) => {
      setParticipants((prev) => {
        const copy = { ...prev };
        delete copy[connId];
        return copy;
      });
      if (pcsRef.current[connId]) {
        pcsRef.current[connId].close();
        delete pcsRef.current[connId];
        const v = document.getElementById("v_" + connId);
        if (v) v.remove();
      }
    });

    connection.on("ReceiveOffer", async (fromConnId, sdp) => {
      try {
        console.log(
          "[SignalR] ReceiveOffer from",
          fromConnId,
          "sdp length",
          sdp?.length
        );
        const pc = await createPc(fromConnId);
        await pc.setRemoteDescription({ type: "offer", sdp });
        // apply any queued remote candidates received before remoteDescription
        if (pc._applyPendingCandidates) await pc._applyPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await connection.invoke("SendAnswer", room, fromConnId, answer.sdp);
        console.log(
          "[SignalR] Sent Answer to",
          fromConnId,
          "answer sdp length",
          answer.sdp?.length
        );
      } catch (e) {
        console.error(e);
      }
    });

    connection.on("ReceiveAnswer", async (fromConnId, sdp) => {
      console.log(
        "[SignalR] ReceiveAnswer from",
        fromConnId,
        "sdp length",
        sdp?.length
      );
      const pc = pcsRef.current[fromConnId];
      if (pc) {
        await pc.setRemoteDescription({ type: "answer", sdp });
        if (pc._applyPendingCandidates) await pc._applyPendingCandidates();
      }
    });

    connection.on("ReceiveIceCandidate", async (fromConnId, candidateJson) => {
      console.log(
        "[SignalR] ReceiveIceCandidate from",
        fromConnId,
        candidateJson && candidateJson.length,
        "chars"
      );
      try {
        const candidate = JSON.parse(candidateJson);
        const pc = await createPc(fromConnId);
        // if remoteDescription is set, add immediately; otherwise queue
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(candidate);
          console.log(
            "[PC] Added remote ICE candidate immediately for",
            fromConnId
          );
        } else {
          pc._pendingRemoteCandidates = pc._pendingRemoteCandidates || [];
          pc._pendingRemoteCandidates.push(candidate);
          console.log("[PC] Queued remote ICE candidate for", fromConnId);
        }
      } catch (e) {
        console.error(e);
      }
    });

    connection.on("RoomEnded", () => {
      alert("Room ended");
    });

    setConn(connection);

    return () => {
      if (connection) connection.stop();
      connRef.current = null;
    };
  }, [room]);

  async function sendMessage() {
    if (!conn || !chatInput.trim()) return;
    try {
      await conn.invoke("SendChatMessage", room, name, chatInput);
      setChatInput("");
    } catch (e) {
      console.error("SendChatMessage error", e);
    }
  }

  async function toggleWave() {
    if (!connRef.current) return;
    if (!isWaving) {
      await connRef.current.invoke("SendWave", room);
    } else {
      await connRef.current.invoke("Unwave", room);
    }
    setIsWaving(!isWaving);
  }
 

  async function ensureLocalStream() {
    if (!localStreamRef.current) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true,
        });
        localStreamRef.current = s;
        if (localVideoRef.current) localVideoRef.current.srcObject = s;
        // initialize mic/cam state from tracks
        const audioTrack = s.getAudioTracks()[0];
        const videoTrack = s.getVideoTracks()[0];
        setMicEnabled(audioTrack ? audioTrack.enabled : false);
        setCamEnabled(videoTrack ? videoTrack.enabled : false);
      } catch (e) {
        alert("getUserMedia error: " + e.message);
        throw e;
      }
    }
    return localStreamRef.current;
  }

  async function toggleMic() {
    await ensureLocalStream();
    const s = localStreamRef.current;
    const audioTracks = s.getAudioTracks();
    if (audioTracks.length === 0) return;
    const track = audioTracks[0];
    track.enabled = !track.enabled;
    setMicEnabled(track.enabled);
  }

  async function toggleCam() {
    await ensureLocalStream();
    const s = localStreamRef.current;
    const videoTracks = s.getVideoTracks();
    if (videoTracks.length === 0) return;
    const track = videoTracks[0];
    track.enabled = !track.enabled;
    setCamEnabled(track.enabled);
  }

  async function kickUser(targetConnId) {
    if (!connRef.current) return;
    await connRef.current.invoke("KickUser", room, targetConnId);
  }


  async function createPc(remoteId) {
    if (pcsRef.current[remoteId]) return pcsRef.current[remoteId];
    const pc = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
    });
    // queue for remote candidates that arrive before remoteDescription is set
    pc._pendingRemoteCandidates = [];
    pc._applyPendingCandidates = async () => {
      while (
        pc._pendingRemoteCandidates &&
        pc._pendingRemoteCandidates.length
      ) {
        const c = pc._pendingRemoteCandidates.shift();
        try {
          await pc.addIceCandidate(c);
        } catch (err) {
          console.warn("addIceCandidate from queue failed", err);
        }
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const candidateJson = JSON.stringify(e.candidate);
      const trySend = async () => {
        try {
          if (connRef.current && connRef.current.invoke) {
            await connRef.current.invoke(
              "SendIceCandidate",
              room,
              remoteId,
              candidateJson
            );
            console.log("[SignalR] Sent ICE candidate to", remoteId);
            return;
          }
        } catch (err) {
          console.warn("SendIceCandidate failed, queuing", err);
        }
        outgoingCandidatesRef.current.push({ remoteId, candidateJson });
      };
      trySend();
    };
    pc.ontrack = (e) => {
      let v = document.getElementById("v_" + remoteId);
      if (!v) {
        v = document.createElement("video");
        v.id = "v_" + remoteId;
        v.autoplay = true;
        v.playsInline = true;
        document.getElementById("remotes").appendChild(v);
      }
      v.srcObject = e.streams[0];
      console.log(
        "[PC] ontrack for",
        remoteId,
        "stream tracks",
        e.streams[0].getTracks().map((t) => t.kind)
      );
    };
    pc.oniceconnectionstatechange = () => {
      console.log(
        "[PC] iceConnectionState:",
        pc.iceConnectionState,
        "for",
        remoteId
      );
      if (pc.iceConnectionState === "failed") {
        console.log("[!] ICE failed, restarting...");
        pc.restartIce?.();
      }
    };
    pc.onconnectionstatechange = () =>
      console.log(
        "[PC] connectionState change for",
        remoteId,
        pc.connectionState
      );
    await ensureLocalStream();
    localStreamRef.current
      .getTracks()
      .forEach((t) => pc.addTrack(t, localStreamRef.current));
    pcsRef.current[remoteId] = pc;
    return pc;
  }

  async function startConnection() {
    if (!conn) return;
    try {
      await conn.start();
      setConnected(true);
      // join room
      await conn.invoke("JoinRoom", room, name);
      const list = await conn.invoke("GetParticipants", room);
      const mapped = Object.fromEntries(
        Object.entries(list || {}).map(([id, name]) => [
          id,
          { name, micEnabled: true, camEnabled: true },
        ])
      );
      setParticipants(mapped);
      // drain any queued outgoing candidates
      if (
        outgoingCandidatesRef.current &&
        outgoingCandidatesRef.current.length
      ) {
        const queue = outgoingCandidatesRef.current.slice();
        outgoingCandidatesRef.current = [];
        for (const item of queue) {
          try {
            if (connRef.current && connRef.current.invoke) {
              await connRef.current.invoke(
                "SendIceCandidate",
                room,
                item.remoteId,
                item.candidateJson
              );
            } else {
              console.warn(
                "No active connection to drain ICE candidate for",
                item.remoteId
              );
            }
          } catch (e) {
            console.warn("drain candidate failed", e);
          }
        }
      }
    } catch (e) {
      console.error("start", e);
      alert("Failed to start connection: " + e.message);
    }
  }

  async function startCall() {
    await ensureLocalStream();
    for (const remoteId of Object.keys(participants)) {
      if (remoteId === myId) continue;
      try {
        const pc = await createPc(remoteId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Retry 3 times
        let retries = 3;
        while (retries > 0) {
          try {
            if (connRef.current?.invoke) {
              await connRef.current.invoke(
                "SendOffer",
                room,
                remoteId,
                offer.sdp
              );
              console.log("[✓] Offer sent to", remoteId);
              break;
            }
          } catch (err) {
            retries--;
            if (retries > 0) {
              await new Promise((r) => setTimeout(r, 500));
            } else throw err;
          }
        }
      } catch (e) {
        console.error("[✗] Failed offer for", remoteId, e);
      }
    }
  }

  async function leaveRoom() {
    if (!conn) return;
    try {
      await conn.invoke("LeaveRoom", room);
      await conn.stop();
    } catch (e) {
      console.warn(e);
    }
    setConnected(false);
    // cleanup
    Object.values(pcsRef.current).forEach((pc) => pc.close());
    pcsRef.current = {};
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setParticipants({});
    setMyId("-");
  }

  return (
    <div className="container">
      <h2>PolyGo React Call Test</h2>
      <div className="controls">
        <input value={room} onChange={(e) => setRoom(e.target.value)} />
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={startConnection} disabled={connected}>
          Join Room
        </button>
        <button onClick={startCall} disabled={!connected}>
          Start Group Call
        </button>

        {isHost && (
          <>
            <button
              onClick={() =>
                Object.keys(participants).forEach((id) => {
                  if (id !== myId)
                    conn.invoke("ToggleMic", room, id, false);
                })
              }
            >
              Mute All
            </button>

            <button
              onClick={() =>
                Object.keys(participants).forEach((id) => {
                  if (id !== myId)
                    conn.invoke("ToggleCam", room, id, false);
                })
              }
            >
              Turn Off All Cameras
            </button>
          </>
        )}


        <button onClick={leaveRoom}>Leave</button>
        <button onClick={toggleMic} title="Toggle microphone">
          {micEnabled ? "Mute Mic" : "Unmute Mic"}
        </button>
        <button onClick={toggleCam} title="Toggle camera">
          {camEnabled ? "Turn Camera Off" : "Turn Camera On"}
        </button>
        <button onClick={toggleWave}>
          {isWaving ? "✋ Lower Hand" : "👋 Raise Hand"}
        </button>

      </div>
      <div>My id: {myId}</div>
      <h3>Participants</h3>
      <ul>
        {Object.entries(participants).map(([id, p]) => (
          <li key={id} style={{ marginBottom: "6px" }}>
            <strong>{p.name}</strong> ({id})

            <span style={{ marginLeft: 10 }}>
              🎤 {p.micEnabled ? "On" : "Off"} | 📷 {p.camEnabled ? "On" : "Off"}
            </span>

            {/* Host-only controls */}
            {isHost && id !== myId && (
              <div style={{ display: "inline-flex", gap: "6px", marginLeft: "12px" }}>
                <button onClick={() => conn.invoke("ToggleMic", room, id, !p.micEnabled)}>
                  {p.micEnabled ? "Mute Mic" : "Unmute Mic"}
                </button>
                <button onClick={() => conn.invoke("ToggleCam", room, id, !p.camEnabled)}>
                  {p.camEnabled ? "Turn Cam Off" : "Turn Cam On"}
                </button>
                <button
                  onClick={() => kickUser(id)}
                  style={{ color: "white", backgroundColor: "red", border: "none", padding: "4px 8px" }}
                >
                  Kick
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>


      <h3>🙌 Hands Raised</h3>
      <div id="waving">
        {Object.entries(wavingUsers).length === 0 ? (
          <p>No hands raised</p>
        ) : (
          <ul>
            {Object.entries(wavingUsers).map(([id, name]) => (
              <li key={id}>{name} 👋</li>
            ))}
          </ul>
        )}
      </div>

      <h3>Local</h3>
      <video ref={localVideoRef} autoPlay muted playsInline id="localVideo" />
      <h3>Remotes</h3>
      <div id="remotes"></div>

      <h3>Chat</h3>
      <div
        ref={chatBoxRef}
        style={{
          border: "1px solid #ccc",
          padding: "8px",
          width: "300px",
          height: "200px",
          overflowY: "auto",
          background: "#f9f9f9",
        }}
      >
        {chatMessages.map((m, i) => (
          <div key={i} style={{ marginBottom: "4px" }}>
            <strong>{m.userName}:</strong> {m.message}
          </div>
        ))}
      </div>


      <div>
        <input
          type="text"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          placeholder="Type a message..."
        />
        <button onClick={sendMessage}>Send</button>
      </div>



    </div>
  );
}
