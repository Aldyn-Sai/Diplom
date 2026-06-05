/*
 * P2P-чат на WebRTC без центрального сервера.
 *
 * Как устанавливается соединение (сигналинг):
 *   Сигнального сервера НЕТ. Применяется внеполосный (out-of-band) ручной сигналинг:
 *   инициатор создаёт SDP Offer, копирует его и передаёт собеседнику через любой
 *   внешний канал (мессенджер, почту). Собеседник вставляет Offer, создаёт SDP Answer
 *   и присылает обратно. После применения Answer браузеры соединяются напрямую.
 *
 * ICE-кандидаты (сетевые адреса) собираются ДО формирования Offer/Answer и уже
 *   "вшиты" в SDP — это режим non-trickle ICE (ожидание сбора см. setTimeout ниже).
 *   Поэтому отдельный обмен кандидатами по сети не нужен.
 *
 * Шифрование: канал данных RTCDataChannel работает поверх SCTP -> DTLS -> UDP.
 *   Шифрование DTLS включено в WebRTC по умолчанию и обязательно, отключить нельзя.
 *   После установки соединения весь трафик идёт напрямую между браузерами и зашифрован.
 *
 * Хранение данных: своей базы данных нет. История сообщений живёт только в памяти
 *   (состояние React allmessages) и стирается при сбросе/выходе — это сделано для приватности.
 */
import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [myusername, setMyusername] = useState('');
  const [myuserid, setMyuserid] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [friendusername, setFriendusername] = useState('');
  const [frienduserid, setFrienduserid] = useState('');
  const [allmessages, setAllmessages] = useState([]);
  const [currentmessage, setCurrentmessage] = useState('');
  const [offertext, setOffertext] = useState('');
  const [answertext, setAnswertext] = useState('');
  const [currentstep, setCurrentstep] = useState('menu');
  const peerconnection = useRef(null);
  const datachannel = useRef(null);
  const messagesEnd = useRef(null);

  // Генерация уникального идентификатора пользователя при загрузке приложения.
  // crypto.randomUUID() даёт UUID версии 4 (RFC 4122) на основе криптографически
  // стойкого генератора случайных чисел (CSPRNG): 122 бита случайности, что делает
  // совпадение двух ID практически невозможным и непредсказуемым. Math.random()
  // используется только как запасной вариант для очень старых браузеров, так как
  // он НЕ криптостойкий и теоретически предсказуем.
  useEffect(() => {
    let generatedid = '';
    try {
      if (crypto.randomUUID) {
        generatedid = crypto.randomUUID();
      } else {
        generatedid = Date.now() + '-' + Math.random();
      }
    } catch(e) {
      generatedid = 'id-' + Date.now() + '-' + Math.random();
    }
    setMyuserid(generatedid);
  }, []);

  useEffect(() => {
    if (messagesEnd.current) {
      messagesEnd.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [allmessages]);

  function addNewMessage(messageText, messageType, senderName = '', senderId = '') {
    const newMessage = {
      id: Date.now(),
      text: messageText,
      type: messageType,
      sender: senderName,
      senderid: senderId,
      time: new Date().getHours() + ':' + (new Date().getMinutes() < 10 ? '0' + new Date().getMinutes() : new Date().getMinutes())
    };
    setAllmessages(prevMessages => [...prevMessages, newMessage]);
  }

  function clearChatHistory() {
    setAllmessages([]);
    addNewMessage('Чат очищен', 'system');
  }

  function setupPeerConnection() {
    // STUN-сервер нужен для обхода NAT: браузер спрашивает у него свой внешний
    // (публичный) IP и порт, чтобы получить server-reflexive ICE-кандидат для связи
    // через интернет. В одной локальной сети (Wi-Fi) хватает host-кандидатов, поэтому
    // соединение работает даже без STUN и без доступа в интернет.
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    };

    const connection = new RTCPeerConnection(config);

    // Используется non-trickle ICE: кандидаты собираются заранее и попадают прямо
    // в SDP (см. ожидание в createOffer/acceptOffer), поэтому отдельно по сети их
    // пересылать не нужно. Обработчик оставлен для наглядности/логирования.
    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        // null-кандидат означает, что сбор ICE-кандидатов завершён.
      }
    };

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') {
        setIsConnected(true);
        setCurrentstep('chat');
        addNewMessage('Соединение установлено!', 'system');
      } else if (connection.connectionState === 'disconnected') {
        setIsConnected(false);
        addNewMessage('Соединение потеряно', 'system');
      } else if (connection.connectionState === 'failed') {
        addNewMessage('Не удалось соединиться', 'system');
      }
    };
    
    return connection;
  }

  function setupDataChannel(channel) {
    channel.onopen = () => {
      addNewMessage('Канал данных открыт', 'system');
      channel.send(JSON.stringify({ 
        type: 'handshake', 
        username: myusername, 
        userid: myuserid 
      }));
    };
    
    channel.onclose = () => {
      setIsConnected(false);
      addNewMessage('Канал данных закрыт', 'system');
    };
    
    // Все сообщения приходят как JSON-строки. Разбираем тип и обрабатываем:
    //  - 'message'   — обычное текстовое сообщение от собеседника;
    //  - 'handshake' — служебное приветствие при открытии канала (имя + ID собеседника).
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'message') {
          addNewMessage(data.text, 'friend', data.username, data.userid);
        }
        else if (data.type === 'handshake') {
          setFriendusername(data.username);
          setFrienduserid(data.userid);
          addNewMessage(data.username + ' присоединился к чату', 'system');
        }
      } catch(error) {
        addNewMessage('Ошибка при получении сообщения', 'system');
      }
    };
  }

  async function createOffer() {
    try {
      addNewMessage('Создаю соединение...', 'system');
      
      const connection = setupPeerConnection();
      peerconnection.current = connection;
      
      const channel = connection.createDataChannel('chat');
      datachannel.current = channel;
      setupDataChannel(channel);
      
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      // Пауза 1 сек — ждём, пока браузер соберёт ICE-кандидаты (non-trickle ICE).
      // После этого localDescription.sdp уже содержит все кандидаты, и Offer можно
      // целиком скопировать и передать собеседнику одним текстом.
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const offerString = JSON.stringify({ 
        type: 'offer', 
        sdp: connection.localDescription.sdp 
      });
      setOffertext(offerString);
      setCurrentstep('waitanswer');
      addNewMessage('Offer создан, отправьте его собеседнику', 'system');
      
    } catch(error) {
      addNewMessage('Ошибка при создании offer: ' + error.message, 'system');
    }
  }

  async function acceptOffer() {
    if (offertext === '') {
      addNewMessage('Сначала вставьте offer от собеседника', 'system');
      return;
    }
    
    if (offertext.trim() === '') {
      addNewMessage('Offer не может быть пустым', 'system');
      return;
    }
    
    try {
      addNewMessage('Обрабатываю offer...', 'system');
      
      const offerData = JSON.parse(offertext);
      
      const connection = setupPeerConnection();
      peerconnection.current = connection;
      
      connection.ondatachannel = (event) => {
        datachannel.current = event.channel;
        setupDataChannel(event.channel);
      };
      
      await connection.setRemoteDescription({ 
        type: 'offer', 
        sdp: offerData.sdp 
      });
      
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      // Пауза 1 сек — ждём сбора ICE-кандидатов (non-trickle ICE), чтобы они попали
      // в SDP. После этого Answer можно целиком скопировать и отправить инициатору.
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const answerString = JSON.stringify({ 
        type: 'answer', 
        sdp: connection.localDescription.sdp 
      });
      setAnswertext(answerString);
      setCurrentstep('sendanswer');
      addNewMessage('Answer создан, отправьте его собеседнику', 'system');
      
    } catch(error) {
      addNewMessage('Ошибка при обработке offer: ' + error.message, 'system');
    }
  }

  async function applyAnswer() {
    if (answertext === '') {
      addNewMessage('Вставьте answer от собеседника', 'system');
      return;
    }
    
    try {
      const answerData = JSON.parse(answertext);
      
      if (peerconnection.current) {
        await peerconnection.current.setRemoteDescription({ 
          type: 'answer', 
          sdp: answerData.sdp 
        });
        addNewMessage('Answer принят, устанавливаем соединение...', 'system');
      } else {
        addNewMessage('Ошибка: соединение не создано', 'system');
      }
      
    } catch(error) {
      addNewMessage('Ошибка при применении answer: ' + error.message, 'system');
    }
  }

  function sendMessage() {
    if (currentmessage === '') {
      return;
    }
    
    if (currentmessage.trim() === '') {
      return;
    }
    
    if (!datachannel.current) {
      addNewMessage('Канал не создан', 'system');
      return;
    }
    
    if (datachannel.current.readyState !== 'open') {
      addNewMessage('Канал не открыт', 'system');
      return;
    }
    
    datachannel.current.send(JSON.stringify({ 
      type: 'message', 
      text: currentmessage, 
      username: myusername,
      userid: myuserid 
    }));
    
    addNewMessage(currentmessage, 'my');
    setCurrentmessage('');
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      addNewMessage('Скопировано в буфер обмена', 'system');
    }).catch(() => {
      addNewMessage('Не удалось скопировать', 'system');
    });
  }

  function resetConnection() {
    if (peerconnection.current) {
      peerconnection.current.close();
    }
    
    peerconnection.current = null;
    datachannel.current = null;
    setIsConnected(false);
    setCurrentstep('menu');
    setOffertext('');
    setAnswertext('');
    setFriendusername('');
    setFrienduserid('');
    clearChatHistory();
    addNewMessage('Соединение сброшено', 'system');
  }

  function logoutFromChat() {
    resetConnection();
    setIsLoggedIn(false);
    setAllmessages([]);
    setFriendusername('');
    setFrienduserid('');
    setMyusername('');
  }

  function displayUserName(name, id) {
    if (!id) {
      return name;
    }
    const shortId = id.substring(0, 4);
    return name + '#' + shortId;
  }

  if (!isLoggedIn) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>P2P Чат</h1>
                    <input
            type="text"
            placeholder="Введите ваше имя"
            value={myusername}
            onChange={(e) => setMyusername(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === 'Enter' && myusername.trim() !== '') {
                setIsLoggedIn(true);
              }
            }}
          />
          <button 
            className="btn-success" 
            onClick={() => {
              if (myusername.trim() !== '') {
                setIsLoggedIn(true);
              }
            }}
          >
            Войти
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="app">
      <div className="header">
        <h1>P2P Чат</h1>
        <div className="user-info">
          <span className="user-name">{displayUserName(myusername, myuserid)}</span>
          <button className="logout-btn" onClick={logoutFromChat}>Выйти</button>
        </div>
      </div>
      
      <div className="chat-container">
        <div className="chat-header">
          <div className="chat-with">
            <span className={`status-dot ${isConnected && friendusername ? 'online' : 'offline'}`}></span>
            <span>
              {isConnected && friendusername 
                ? displayUserName(friendusername, frienduserid)
                : 'Ожидание подключения'}
              </span>
          </div>
          <button className="btn-danger" onClick={resetConnection}>Сбросить</button>
        </div>
        
        <div className="messages-area">
          {allmessages.map((msg) => (
            <div key={msg.id} className={`message ${msg.type}`}>
              <div className="message-bubble">
                {msg.type === 'friend' && (
                  <div className="sender">
                    {displayUserName(msg.sender, msg.senderid)}
                  </div>
                )}
                {msg.text}
                <div className="time">{msg.time}</div>
              </div>
            </div>
          ))}
          <div ref={messagesEnd} />
        </div>
        
        {currentstep === 'menu' && !isConnected && (
          <div className="action-card">
            <h2 className="action-title">Новое соединение</h2>
            <button className="btn-success" onClick={createOffer} style={{ marginBottom: '16px' }}>
              Создать Offer
            </button>
            <div className="or-divider">или</div>
            <div style={{ marginTop: '24px' }}>
              <label className="label">Вставить Offer собеседника</label>
              <textarea
                className="textarea-field"
                rows="4"
                placeholder='{"type":"offer","sdp":"..."}'
                value={offertext}
                onChange={(e) => setOffertext(e.target.value)}
              />
              <button className="btn-primary" onClick={acceptOffer}>
                Принять Offer
              </button>
            </div>
          </div>
        )}
        
        {currentstep === 'waitanswer' && !isConnected && (
          <div className="waiting-state">
            <h3 className="waiting-title">Отправьте Offer</h3>
            <p className="waiting-text">Скопируйте данные и отправьте собеседнику</p>
            <textarea className="textarea-field" rows="6" readOnly value={offertext} />
            <button className="btn-success" onClick={() => copyToClipboard(offertext)} style={{ marginBottom: '24px' }}>
              Копировать
            </button>
            <label className="label">Вставить Answer собеседника</label>
            <textarea
              className="textarea-field"
              rows="4"
              placeholder='{"type":"answer","sdp":"..."}'
              value={answertext}
              onChange={(e) => setAnswertext(e.target.value)}
            />
            <button className="btn-primary" onClick={applyAnswer}>
              Применить Answer
            </button>
          </div>
        )}
        
        {currentstep === 'sendanswer' && !isConnected && (
          <div className="waiting-state">
            <h3 className="waiting-title">Отправьте Answer</h3>
            <p className="waiting-text">Скопируйте данные и отправьте инициатору</p>
            <textarea className="textarea-field" rows="6" readOnly value={answertext} />
            <button className="btn-success" onClick={() => copyToClipboard(answertext)}>
              Копировать
            </button>
          </div>
        )}
        
        {currentstep === 'chat' && isConnected && (
          <div className="input-area">
            <input
              type="text"
              placeholder="Сообщение..."
              value={currentmessage}
              onChange={(e) => setCurrentmessage(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  sendMessage();
                }
              }}
            />
            <button onClick={sendMessage}>→</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;