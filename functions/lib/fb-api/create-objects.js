const fbBizSdk = require('facebook-nodejs-business-sdk')

const Content = fbBizSdk.Content
const DeliveryCategory = fbBizSdk.DeliveryCategory
const CustomData = fbBizSdk.CustomData
const ServerEvent = fbBizSdk.ServerEvent
const UserData = fbBizSdk.UserData

const createContent = (item) => {
  const content = (new Content())
    .setId(item.sku || item.product_id)
    .setQuantity(item.quantity)
    .setDeliveryCategory(DeliveryCategory.HOME_DELIVERY)
  if (item.name) {
    content.setTitle(item.name)
  }

  return content
}

const createCustonData = (contents, total, currencyId) => {
  const customData = (new CustomData())
    .setContents(contents)
    .setCurrency((currencyId && currencyId.toLowerCase()) || 'brl')
    .setValue(Math.round(total * 100) / 100)
    .setNumItems(contents.length)

  return customData
}

const createUserData = (customer, clientIp) => {
  const userData = new UserData()
  userData.setExternalId(customer._id)
  const emails = customer.emails || []
  if (customer.main_email) {
    emails.push({ address: customer.main_email })
  }
  if (emails.length) {
    userData.setEmails(emails.map(({ address }) => address))
  }
  if (customer.phones && customer.phones.length) {
    userData.setPhones(customer.phones.map(({ number }) => String(number)))
  }
  if (customer.name && customer.name.given_name) {
    userData.setFirstName(customer.name.given_name)
    if (customer.name.family_name) {
      userData.setLastName(customer.name.family_name)
    }
  }
  if (customer.gender === 'f' || customer.gender === 'm') {
    userData.setGender(customer.gender)
  }

  if (clientIp) {
    userData.setClientIpAddress(clientIp)
  }

  return userData
}

const createServeEvent = (
  eventName,
  eventTimeMs,
  userData,
  customData,
  eventId,
  eventSourceUrl
) => {
  const serverEvent = (new ServerEvent())
    .setEventName(eventName)
    .setEventTime(Math.round(eventTimeMs / 1000))
    .setCustomData(customData)
    .setActionSource('website')

  if (userData) {
    serverEvent.setUserData(userData)
  }

  if (eventSourceUrl) {
    serverEvent.setEventSourceUrl(eventSourceUrl)
  }
  serverEvent.setEventId(eventId)

  return serverEvent
}

module.exports = {
  createContent,
  createCustonData,
  createServeEvent,
  createUserData
}
